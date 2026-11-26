// Owner approval inbox (SPEC FR-13, FR-14, Flow 3 steps 4-5; AI reply generation: flags). Every query is scoped to the
// session's location, which comes from the session and never from the request. Nothing here posts to Google: an
// approved draft waits for the poster (FR-15), and nothing is ever approved without an owner action.
// Audit rows carry IDs, edited yes/no and minutes to approve, never review or reply text.
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, replyDrafts, reviews } from "../db/schema";
import { MAX_REPLY_BYTES } from "../google/businessProfile";
import type { OwnerSession } from "./auth";

const HOUR = 60 * 60 * 1000;
export const OVERDUE_MS = 48 * HOUR; // Flow 3 step 5
export const POSTED_WINDOW_MS = 30 * 24 * HOUR; // FR-13: replies posted in the last 30 days
export const MAX_REPLY_CHARS = 4000; // Google caps a reply at 4096 bytes; leave room for multi-byte text

export type InboxItem = {
  draftId: string;
  status: "awaiting_owner" | "held" | "approved" | "posted";
  rating: number;
  reviewerName: string | null;
  reviewText: string | null;
  reviewPostedAt: Date | null;
  flags: string[];
  draftText: string;
  finalText: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  postedAt: Date | null;
  overdue: boolean;
};

export type Inbox = { pending: InboxItem[]; approved: InboxItem[]; posted: InboxItem[] };

export async function listInbox(session: OwnerSession, opts: { now?: Date } = {}, db: Db = defaultDb): Promise<Inbox> {
  const now = opts.now ?? new Date();
  const cols = {
    draftId: replyDrafts.id,
    status: replyDrafts.status,
    rating: reviews.rating,
    reviewerName: reviews.reviewerName,
    reviewText: reviews.text,
    reviewPostedAt: reviews.postedAt,
    flags: reviews.flags,
    draftText: replyDrafts.draftText,
    finalText: replyDrafts.finalText,
    createdAt: replyDrafts.createdAt,
    approvedAt: replyDrafts.approvedAt,
    postedAt: replyDrafts.postedAt,
  };
  const base = () =>
    db
      .select(cols)
      .from(replyDrafts)
      .innerJoin(reviews, and(eq(reviews.id, replyDrafts.reviewId), eq(reviews.locationId, replyDrafts.locationId)));
  const here = eq(replyDrafts.locationId, session.locationId);

  const [pending, approved, posted] = await Promise.all([
    base()
      .where(and(here, inArray(replyDrafts.status, ["awaiting_owner", "held"])))
      .orderBy(asc(replyDrafts.createdAt)),
    base()
      .where(and(here, eq(replyDrafts.status, "approved")))
      .orderBy(desc(replyDrafts.approvedAt)),
    base()
      .where(
        and(
          here,
          eq(replyDrafts.status, "posted"),
          gt(replyDrafts.postedAt, new Date(now.getTime() - POSTED_WINDOW_MS)),
        ),
      )
      .orderBy(desc(replyDrafts.postedAt)),
  ]);
  const item = (r: (typeof pending)[number]): InboxItem => ({
    ...r,
    status: r.status as InboxItem["status"],
    overdue:
      (r.status === "awaiting_owner" || r.status === "held") && now.getTime() - r.createdAt.getTime() >= OVERDUE_MS,
  });
  return { pending: pending.map(item), approved: approved.map(item), posted: posted.map(item) };
}

// approve: one-tap approval, only for a draft without flags (awaiting_owner).
// approve_anyway: a held (flagged) draft, after the owner confirms they read it.
// edit: the owner's own text replaces the draft and is approved (held or not).
// reject: the draft is never posted.
export type Decision =
  | { action: "approve" }
  | { action: "approve_anyway"; confirmed: boolean }
  | { action: "edit"; text: string }
  | { action: "reject" };

export type DecisionResult =
  | { ok: true; status: "approved" | "rejected"; edited: boolean }
  | { ok: false; reason: "not_found" | "not_allowed" | "needs_confirmation" | "empty_text" | "too_long" };

const ALLOWED_FROM = {
  approve: ["awaiting_owner"],
  approve_anyway: ["held"],
  edit: ["awaiting_owner", "held"],
  reject: ["awaiting_owner", "held"],
} as const;

export async function decide(
  session: OwnerSession,
  draftId: string,
  decision: Decision,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
): Promise<DecisionResult> {
  const now = opts.now ?? new Date();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftId))
    return { ok: false, reason: "not_found" };
  if (decision.action === "approve_anyway" && !decision.confirmed) return { ok: false, reason: "needs_confirmation" };
  let text: string | undefined;
  if (decision.action === "edit") {
    text = decision.text.replace(/\r\n/g, "\n").trim();
    if (!text) return { ok: false, reason: "empty_text" };
    // Google takes at most 4,096 UTF-8 bytes (FR-15); accented or emoji text reaches that before 4,000 characters.
    if (text.length > MAX_REPLY_CHARS || Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES)
      return { ok: false, reason: "too_long" };
  }

  return db.transaction(async (tx) => {
    // Lock the draft so a double submit or a second tab sees the first decision.
    const [d] = await tx
      .select({ status: replyDrafts.status, draftText: replyDrafts.draftText, createdAt: replyDrafts.createdAt })
      .from(replyDrafts)
      .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.locationId, session.locationId)))
      .for("update");
    if (!d) return { ok: false, reason: "not_found" } as const; // includes another location's draft
    if (!(ALLOWED_FROM[decision.action] as readonly string[]).includes(d.status))
      return { ok: false, reason: "not_allowed" } as const;

    // A held draft has no one-tap approve (SPEC, AI reply generation: "the owner must edit it or open it and confirm
    // 'Approve anyway'"). Saving the pre-filled edit form unchanged is not an edit, so it needs the confirmation too.
    if (decision.action === "edit" && d.status === "held" && text === d.draftText.replace(/\r\n/g, "\n").trim())
      return { ok: false, reason: "needs_confirmation" } as const;

    const approving = decision.action !== "reject";
    const finalText = approving ? (text ?? d.draftText) : null;
    const edited = approving && finalText !== d.draftText;
    await tx
      .update(replyDrafts)
      .set(
        approving
          ? { status: "approved", finalText, approvedSessionId: session.sessionId, approvedAt: now }
          : { status: "rejected" },
      )
      .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.locationId, session.locationId)));

    const minutes = Math.max(0, Math.round((now.getTime() - d.createdAt.getTime()) / 60000));
    await tx.insert(auditLog).values({
      locationId: session.locationId,
      entity: "reply_draft",
      entityId: draftId,
      action: approving ? "approved" : "rejected",
      actor: `owner_session:${session.sessionId}`,
      detail: approving
        ? `edited=${edited ? "yes" : "no"};minutes=${minutes};flagged=${d.status === "held" ? "yes" : "no"}`
        : `minutes=${minutes};flagged=${d.status === "held" ? "yes" : "no"}`,
    });
    return { ok: true, status: approving ? "approved" : "rejected", edited } as const;
  });
}
