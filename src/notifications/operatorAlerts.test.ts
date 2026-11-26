// Runs against the Postgres in DATABASE_URL. Fake data only; the email provider is a fake and nothing is sent.
import { and, desc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { operatorEmailFromEnv, sendOperatorAlerts } from "./operatorAlerts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Each test runs a day after the previous one (tests pass `now` explicitly), so the send-failure watermark and every
// stretch an earlier test left behind are in the past.
let NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const OPERATOR = "operator@example.test";

class FakeEmail implements EmailProvider {
  sent: EmailMessage[] = [];
  failNext = false;
  async send(m: EmailMessage) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider timeout");
    }
    this.sent.push(m);
  }
}
let email: FakeEmail;
const run = (now = NOW) => sendOperatorAlerts({ email, operatorEmail: OPERATOR, now });

const businessIds: string[] = [];
let n = 0;
async function makeLocation(
  opts: {
    connectedAt?: Date | null;
    token?: "active" | "refresh_failed" | "revoked" | null;
    status?: "live" | "offboarded";
  } = {},
) {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: `Alert Test Electric ${++n}`, vertical: "electrical", status: opts.status ?? "live" })
    .returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/test",
      googleLocationId: `locations/alert-test-${crypto.randomUUID()}`,
      googleConnectedAt: opts.connectedAt === undefined ? ago(48 * HOUR) : opts.connectedAt,
    })
    .returning();
  const [t] =
    opts.token === null
      ? [undefined]
      : await db
          .insert(s.oauthTokens)
          .values({
            locationId: l.id,
            encryptedRefreshToken: "not-a-real-token",
            scopes: ["https://www.googleapis.com/auth/business.manage"],
            status: opts.token ?? "active",
            revokedAt: opts.token === "revoked" ? ago(HOUR) : null,
          })
          .returning();
  return { locationId: l.id, businessName: b.name, tokenId: t?.id };
}

const audit = (locationId: string, action: string, at: Date, extra: Partial<typeof s.auditLog.$inferInsert> = {}) =>
  db.insert(s.auditLog).values({
    locationId,
    entity: "location",
    entityId: locationId,
    action,
    actor: "test",
    at,
    ...extra,
  });
const polled = (locationId: string, at: Date) => audit(locationId, "reviews_polled", at);
const sendFailed = (locationId: string, at: Date, channel = "sms", error = "timeout") => {
  const id = crypto.randomUUID();
  return audit(locationId, "failed", at, {
    entity: "review_request",
    entityId: id,
    detail: `attempt=1;channel=${channel};error=${error}`,
  }).then(() => id);
};
const alertRows = (locationIds: string[]) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(inArray(s.auditLog.locationId, locationIds), eq(s.auditLog.action, "operator_alert_sent")));

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  // The audit log is append-only, so alert rows from an earlier run of this file stay. Start after the latest.
  const [last] = await db
    .select({ at: s.auditLog.at })
    .from(s.auditLog)
    .where(eq(s.auditLog.actor, "system:operator_alert"))
    .orderBy(desc(s.auditLog.at))
    .limit(1);
  if (last && last.at > NOW) NOW = last.at;
});
beforeEach(async () => {
  email = new FakeEmail();
  NOW = new Date(NOW.getTime() + 24 * HOUR);
  // Each test starts with nothing unreported: earlier tests' problems are recorded as already reported.
  await run();
  email = new FakeEmail();
});
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("review check not run in 3 hours", () => {
  it("alerts once for a location last checked 3 or more hours ago, and again after a later stretch", async () => {
    const stale = await makeLocation();
    const fresh = await makeLocation();
    await polled(stale.locationId, ago(3 * HOUR + MIN));
    await polled(fresh.locationId, ago(20 * MIN));

    const r = await run();
    expect(r).toMatchObject({ sent: 1, staleChecks: 1, expiredTokens: 0, failedSends: 0 });
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe(OPERATOR);
    expect(m.subject).toBe("Kindword alert: 1 review check not run in 3 hours");
    expect(m.text).toContain(`${stale.businessName} (Main, location ${stale.locationId}): last successful check`);
    expect(m.text).toContain("(3 hours ago)");
    expect(m.text).not.toContain(fresh.locationId);
    expect(await alertRows([stale.locationId, fresh.locationId])).toHaveLength(1);

    // Still stale: not reported again.
    await run(new Date(NOW.getTime() + HOUR));
    expect(email.sent).toHaveLength(1);

    // A check succeeds, then stops again: a new stretch, reported again.
    await polled(stale.locationId, new Date(NOW.getTime() + 2 * HOUR));
    await run(new Date(NOW.getTime() + 5 * HOUR + MIN));
    expect(email.sent).toHaveLength(2);
    expect(email.sent[1].text).toContain(stale.locationId);
    expect(await alertRows([stale.locationId])).toHaveLength(2);
  });

  it("dates a never-checked location from when Google was connected", async () => {
    const old = await makeLocation({ connectedAt: ago(5 * HOUR) });
    const justConnected = await makeLocation({ connectedAt: ago(10 * MIN) });
    await run();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].text).toContain(`location ${old.locationId}): never checked successfully.`);
    expect(email.sent[0].text).not.toContain(justConnected.locationId);
  });

  it("ignores locations that are not checked: no token, revoked, offboarded", async () => {
    const a = await makeLocation({ token: null });
    const b = await makeLocation({ token: "revoked" });
    const c = await makeLocation({ status: "offboarded" });
    const r = await run();
    expect(r.sent).toBe(0);
    expect(email.sent).toHaveLength(0);
    expect(await alertRows([a.locationId, b.locationId, c.locationId])).toHaveLength(0);
  });
});

describe("Google connection expired", () => {
  it("alerts once per failure for a refresh_failed token, and not also as a stale check", async () => {
    const loc = await makeLocation({ token: "refresh_failed" });
    await polled(loc.locationId, ago(10 * HOUR));
    await audit(loc.locationId, "review_poll_failed", ago(9 * HOUR), { detail: "code=token_revoked" });

    const r = await run();
    expect(r).toMatchObject({ sent: 1, expiredTokens: 1, staleChecks: 0 });
    expect(email.sent[0].subject).toBe("Kindword alert: 1 Google connection expired");
    expect(email.sent[0].text).toContain(
      `location ${loc.locationId}): Google refused our access at ${ago(9 * HOUR).toISOString()}.`,
    );
    expect(email.sent[0].text).toContain("The owner needs to connect Google again.");
    const [row] = await alertRows([loc.locationId]);
    expect(row).toMatchObject({ entity: "oauth_token", entityId: loc.tokenId });

    await run(new Date(NOW.getTime() + HOUR));
    expect(email.sent).toHaveLength(1);

    // Reconnected and refused again later: a new failure, reported again.
    await audit(loc.locationId, "review_poll_failed", new Date(NOW.getTime() + 2 * HOUR), {
      detail: "code=token_revoked",
    });
    await run(new Date(NOW.getTime() + 3 * HOUR));
    expect(email.sent).toHaveLength(2);
  });
});

describe("failed sends", () => {
  it("reports each failed send once, grouped by location with channel and error counts", async () => {
    const loc = await makeLocation();
    await polled(loc.locationId, ago(MIN));
    const ids = [
      await sendFailed(loc.locationId, ago(30 * MIN)),
      await sendFailed(loc.locationId, ago(20 * MIN)),
      await sendFailed(loc.locationId, ago(10 * MIN), "email", "outcome_unknown"),
    ];
    const settling = await sendFailed(loc.locationId, ago(30 * 1000)); // too recent: left for the next run

    const r = await run();
    expect(r).toMatchObject({ sent: 1, failedSends: 3 });
    const m = email.sent[0];
    expect(m.subject).toBe("Kindword alert: 3 failed sends");
    expect(m.text).toContain(`location ${loc.locationId}): email outcome_unknown x1, sms timeout x2.`);
    for (const id of ids) expect(m.text).toContain(id);
    expect(m.text).not.toContain(settling);

    // The next run reports only what is new: the settling one, and a later failure.
    const later = await sendFailed(loc.locationId, new Date(NOW.getTime() + MIN));
    await run(new Date(NOW.getTime() + 10 * MIN));
    expect(email.sent).toHaveLength(2);
    expect(email.sent[1].subject).toBe("Kindword alert: 2 failed sends");
    expect(email.sent[1].text).toContain(settling);
    expect(email.sent[1].text).toContain(later);
    for (const id of ids) expect(email.sent[1].text).not.toContain(id);

    await run(new Date(NOW.getTime() + 20 * MIN));
    expect(email.sent).toHaveLength(2);
  });

  it("carries IDs, names, codes and counts only: no addresses, phone numbers or message text", async () => {
    const loc = await makeLocation();
    await polled(loc.locationId, ago(MIN));
    await sendFailed(loc.locationId, ago(10 * MIN));
    await run();
    const m = email.sent[0];
    expect(`${m.subject}\n${m.text}\n${m.html}`).not.toMatch(/@|\+1\d{10}|555/);
    expect(m.idempotencyKey).toMatch(/^operator-alert\/[0-9a-f]{32}$/);
  });
});

describe("one email per run, idempotent", () => {
  it("puts every kind of problem in one email", async () => {
    const stale = await makeLocation();
    await polled(stale.locationId, ago(4 * HOUR));
    const expired = await makeLocation({ token: "refresh_failed" });
    await sendFailed(expired.locationId, ago(5 * MIN));
    await run();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].subject).toBe(
      "Kindword alert: 1 failed send, 1 Google connection expired, 1 review check not run in 3 hours",
    );
    expect(email.sent[0].text).toContain("Failed sends:");
    expect(email.sent[0].text).toContain("Google connection expired:");
    expect(email.sent[0].text).toContain("Review check not run in 3 hours:");
  });

  it("records nothing when the email provider fails, and reports again with the same key", async () => {
    const loc = await makeLocation();
    await polled(loc.locationId, ago(5 * HOUR));
    email.failNext = true;
    const r = await run();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(await alertRows([loc.locationId])).toHaveLength(0);
    const retry = await run();
    expect(retry.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(await alertRows([loc.locationId])).toHaveLength(1);
  });

  it("sends one email when two runs overlap", async () => {
    const loc = await makeLocation();
    await polled(loc.locationId, ago(6 * HOUR));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.sent + b.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(await alertRows([loc.locationId])).toHaveLength(1);
  });

  it("sends nothing and records nothing on a quiet run", async () => {
    const before = await db.select().from(s.auditLog).where(eq(s.auditLog.actor, "system:operator_alert"));
    const r = await run();
    expect(r).toEqual({ sent: 0, failed: 0, staleChecks: 0, expiredTokens: 0, failedSends: 0 });
    const after = await db.select().from(s.auditLog).where(eq(s.auditLog.actor, "system:operator_alert"));
    expect(after).toHaveLength(before.length);
  });
});

describe("operatorEmailFromEnv", () => {
  it("reads OPERATOR_EMAIL and names the setting when it is missing or malformed, never its value", () => {
    expect(operatorEmailFromEnv({ OPERATOR_EMAIL: " ops@example.test " })).toBe("ops@example.test");
    for (const v of [undefined, "", "not-an-email", "a@b.c, x@y.z"])
      expect(() => operatorEmailFromEnv({ OPERATOR_EMAIL: v })).toThrow(
        /^OPERATOR_EMAIL missing or not an email address$/,
      );
  });
});
