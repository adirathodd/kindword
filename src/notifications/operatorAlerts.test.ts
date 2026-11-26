// Runs against the Postgres in DATABASE_URL. Fake data only: example.test addresses, made-up IDs.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { ALERT_ACTIONS, REVIEW_CHECK_STALE_MS, sendOperatorAlerts } from "./operatorAlerts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-26T15:00:00Z");
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR);
const OPERATOR = "operator@example.test";

class FakeEmail implements EmailProvider {
  sent: EmailMessage[] = [];
  failNext = 0;
  async send(m: EmailMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("provider down");
    }
    this.sent.push(m);
  }
}

const businessIds: string[] = [];
let n = 0;
async function location(
  opts: {
    status?: (typeof s.businessStatus.enumValues)[number];
    token?: (typeof s.oauthStatus.enumValues)[number] | null;
    connectedAt?: Date | null;
  } = {},
) {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: `Alert Test Plumbing ${n++}`, vertical: "plumbing", status: opts.status ?? "live" })
    .returning();
  businessIds.push(b.id);
  const token = opts.token === undefined ? null : opts.token;
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main St",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/t",
      googleLocationId: token ? `locations/${n}` : null,
      googleConnectedAt: opts.connectedAt === undefined ? null : opts.connectedAt,
    })
    .returning();
  let tokenId: string | null = null;
  if (token) {
    const [t] = await db
      .insert(s.oauthTokens)
      .values({ locationId: l.id, encryptedRefreshToken: "x", scopes: ["business.manage"], status: token })
      .returning();
    tokenId = t.id;
  }
  return { locationId: l.id, businessName: b.name, tokenId };
}

const audit = (
  locationId: string | null,
  entity: string,
  entityId: string,
  action: string,
  detail: string | null,
  when: Date,
) => db.insert(s.auditLog).values({ locationId, entity, entityId, action, actor: "test", detail, at: when });

const failedSend = (locationId: string | null, channel: "sms" | "email", error: string, when = at(-1)) => {
  const id = randomUUID();
  return audit(locationId, "review_request", id, "failed", `attempt=1;channel=${channel};error=${error}`, when).then(
    () => id,
  );
};
const polled = (locationId: string, when: Date) =>
  audit(locationId, "location", locationId, "reviews_polled", null, when);

const run = (email: FakeEmail, now = NOW) => sendOperatorAlerts({ email, operatorEmail: OPERATOR, now });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});
// Other test files leave audit rows and locations behind in the shared database. Alert everything that exists now,
// at a time after every test's clock, so each test sees only what it seeds.
beforeEach(async () => {
  await run(new FakeEmail(), at(24 * 30));
});
afterAll(async () => {
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("nothing to report", () => {
  it("sends nothing and records nothing", async () => {
    const email = new FakeEmail();
    expect(await run(email)).toEqual({ sent: 0, sendFailed: 0, tokenExpired: 0, reviewCheckStale: 0 });
    expect(email.sent).toEqual([]);
  });
});

describe("failed sends", () => {
  it("emails the operator once, grouped per location, with codes and counts and no personal data", async () => {
    const { locationId, businessName } = await location();
    const a = await failedSend(locationId, "sms", "provider_rejected");
    const b = await failedSend(locationId, "sms", "provider_rejected");
    const c = await failedSend(locationId, "email", "outcome_unknown");
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 1, sendFailed: 3 });
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe(OPERATOR);
    expect(m.subject).toContain("3 review request sends failed");
    expect(m.text).toContain(`${businessName} (Main St, location ${locationId})`);
    expect(m.text).toContain("2 sends (text, refused by the provider)");
    expect(m.text).toContain("1 send (email, outcome unknown");
    expect(m.html).toContain("<ul>");
    expect(m.idempotencyKey).toMatch(/^operator-alert\/[0-9a-f]{64}$/);
    for (const body of [m.text, m.html, m.subject]) expect(body).not.toMatch(/@|\+1\d{10}/);

    const rows = await db
      .select({ entityId: s.auditLog.entityId, detail: s.auditLog.detail })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, ALERT_ACTIONS.send_failed), inArray(s.auditLog.entityId, [a, b, c])));
    expect(rows).toHaveLength(3);

    expect(await run(email, at(1))).toMatchObject({ sent: 0 }); // each failure is reported once
    expect(email.sent).toHaveLength(1);
  });

  it("reports a later failure in a new email", async () => {
    const { locationId } = await location();
    await failedSend(locationId, "sms", "outcome_unknown");
    const email = new FakeEmail();
    await run(email);
    await failedSend(locationId, "email", "provider_rejected", at(0.5));
    expect(await run(email, at(1))).toMatchObject({ sent: 1, sendFailed: 1 });
    expect(email.sent[1].text).toContain("1 send (email, refused by the provider)");
    expect(email.sent[1].idempotencyKey).not.toBe(email.sent[0].idempotencyKey);
  });

  it("still reports a failure whose location was deleted, and skips offboarded businesses", async () => {
    const off = await location({ status: "offboarded" });
    await failedSend(off.locationId, "sms", "provider_rejected");
    await failedSend(randomUUID(), "sms", "provider_rejected"); // location row gone
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 1, sendFailed: 1 });
    expect(email.sent[0].text).toContain("Unknown business (unknown location");
    expect(email.sent[0].text).not.toContain(off.businessName);
  });

  it("records nothing when the email provider fails, and retries with the same idempotency key", async () => {
    const { locationId } = await location();
    await failedSend(locationId, "sms", "provider_rejected");
    const email = new FakeEmail();
    email.failNext = 1;
    await expect(run(email)).rejects.toThrow("provider down");
    expect(await run(email, at(0.25))).toMatchObject({ sent: 1, sendFailed: 1 });
    expect(email.sent).toHaveLength(1);
    const again = new FakeEmail();
    expect(await run(again, at(0.5))).toMatchObject({ sent: 0 });
  });

  it("sends one email when two runs overlap", async () => {
    const { locationId } = await location();
    await failedSend(locationId, "email", "provider_rejected");
    const email = new FakeEmail();
    const results = await Promise.all([run(email), run(email)]);
    expect(results.map((r) => r.sent).sort()).toEqual([0, 1]);
    expect(email.sent).toHaveLength(1);
  });
});

describe("expired Google access", () => {
  it("alerts once per failure, and again after a reconnect fails", async () => {
    const { locationId, tokenId, businessName } = await location({ token: "refresh_failed" });
    await audit(locationId, "location", locationId, "review_poll_failed", "code=token_revoked", at(-2));
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 1, tokenExpired: 1, reviewCheckStale: 0 });
    expect(email.sent[0].subject).toContain("Google access stopped working for 1 location");
    expect(email.sent[0].text).toContain(`${businessName} (Main St, location ${locationId}): Google refused`);
    expect(await run(email, at(1))).toMatchObject({ sent: 0 });

    // The owner reconnects (same row back to active), then Google refuses again.
    await db.update(s.oauthTokens).set({ status: "active" }).where(eq(s.oauthTokens.id, tokenId!));
    await polled(locationId, at(2));
    await db.update(s.oauthTokens).set({ status: "refresh_failed" }).where(eq(s.oauthTokens.id, tokenId!));
    await audit(locationId, "location", locationId, "review_poll_failed", "code=token_revoked", at(2.5));
    expect(await run(email, at(3))).toMatchObject({ sent: 1, tokenExpired: 1 });
  });

  it("ignores revoked tokens, active tokens and offboarded businesses", async () => {
    const revoked = await location({ token: "revoked" });
    await audit(revoked.locationId, "location", revoked.locationId, "review_poll_failed", "code=token_revoked", at(-2));
    const off = await location({ token: "refresh_failed", status: "offboarded" });
    await audit(off.locationId, "location", off.locationId, "review_poll_failed", "code=token_revoked", at(-2));
    const ok = await location({ token: "active" });
    await polled(ok.locationId, at(-0.25));
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 0 });
  });
});

describe("review check not run in 3 hours", () => {
  it("alerts when the last successful check is over 3 hours old, once per stale period", async () => {
    const { locationId } = await location({ token: "active", connectedAt: at(-48) });
    await polled(locationId, at(-3.5));
    // A failed poll is not a check that ran successfully.
    await audit(locationId, "location", locationId, "review_poll_failed", "code=unavailable", at(-0.25));
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 1, reviewCheckStale: 1 });
    expect(email.sent[0].subject).toContain("Review check has not run in 3 hours for 1 location");
    expect(email.sent[0].text).toContain("last successful check 3 hours ago");
    expect(await run(email, at(5))).toMatchObject({ sent: 0 });

    // Polling recovers, then stops again: a new stale period, a new alert.
    await polled(locationId, at(6));
    expect(await run(email, at(8))).toMatchObject({ sent: 0 });
    expect(await run(email, at(6 + REVIEW_CHECK_STALE_MS / HOUR))).toMatchObject({ sent: 1, reviewCheckStale: 1 });
  });

  it("does not alert while checks are recent", async () => {
    const { locationId } = await location({ token: "active", connectedAt: at(-48) });
    await polled(locationId, at(-2.9));
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 0 });
  });

  it("counts a location never checked from when Google was connected", async () => {
    const fresh = await location({ token: "active", connectedAt: at(-1) });
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 0 });
    expect(await run(email, at(2.5))).toMatchObject({ sent: 1, reviewCheckStale: 1 });
    expect(email.sent[0].text).toContain(`location ${fresh.locationId}): never checked successfully`);
  });

  it("leaves out locations without Google, with a failed or revoked token, or offboarded", async () => {
    await location({ connectedAt: at(-48) });
    await location({ token: "revoked", connectedAt: at(-48) });
    await location({ token: "active", connectedAt: at(-48), status: "offboarded" });
    const email = new FakeEmail();
    expect(await run(email)).toMatchObject({ sent: 0 });
  });

  it("combines every kind of new problem in one email", async () => {
    const stale = await location({ token: "active", connectedAt: at(-10) });
    const expired = await location({ token: "refresh_failed" });
    await audit(expired.locationId, "location", expired.locationId, "review_poll_failed", "code=token_revoked", at(-1));
    await failedSend(stale.locationId, "sms", "provider_opted_out");
    const email = new FakeEmail();
    expect(await run(email)).toEqual({ sent: 1, sendFailed: 1, tokenExpired: 1, reviewCheckStale: 1 });
    expect(email.sent[0].text).toContain("3 new problems for Kindword");
    expect(email.sent[0].text).toContain("customer had opted out at the provider");
  });
});
