// Scheduled-job dispatch and retries: each schedule name reaches its job code (mocked here), a missing setting is
// named and not retried, a transient failure is retried with backoff and dropped after MAX_DELIVERIES. Runs against
// the Postgres in DATABASE_URL for the sheet-source lookup. Fake data only.
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";

const calls = vi.hoisted(() => ({ list: [] as string[], failPurge: false }));
const track =
  <T>(name: string, value: T) =>
  async () => {
    calls.list.push(name);
    if (name === "purgeExpiredReviews" && calls.failPurge) throw new Error("connection reset");
    return value;
  };
vi.mock("../intake/pollSheet", () => ({ pollSheet: track("pollSheet", { ok: true, rows: [] }) }));
vi.mock("../requests/requests", async (orig) => ({
  ...(await orig<object>()),
  runReviewRequestJobs: track("runReviewRequestJobs", {
    scheduled: { scheduled: 0, skipped: {} },
    reminders: { scheduled: 0 },
    sent: { sent: 0, failed: 0, deferred: 0, waiting: 0, skipped: {} },
  }),
}));
vi.mock("../reviews/poll", () => ({ pollReviews: track("pollReviews", { locations: 0, newReviews: 0, failed: [] }) }));
vi.mock("../reviews/draft", () => ({ draftPendingReviews: track("draftPendingReviews", { drafted: 0 }) }));
vi.mock("../notifications/ownerEmails", () => ({
  sendLowRatingAlerts: track("sendLowRatingAlerts", { sent: 0, failed: 0 }),
  sendDailyDigests: track("sendDailyDigests", { sent: 0, failed: 0 }),
}));
vi.mock("../reviews/purge", () => ({
  purgeExpiredReviews: track("purgeExpiredReviews", { reviews: 0, drafts: 0, cutoff: new Date() }),
}));
vi.mock("../notifications/operatorAlerts", async (orig) => ({
  ...(await orig<object>()),
  sendOperatorAlerts: track("sendOperatorAlerts", {
    sent: 0,
    failed: 0,
    staleChecks: 0,
    expiredTokens: 0,
    failedSends: 0,
  }),
}));
vi.mock("../reports/monthly", () => ({
  sendMonthlyReports: track("sendMonthlyReports", { sent: 0, failed: 0, waiting: 0 }),
}));

const { JobFailedError, MAX_DELIVERIES, retryPolicy, runScheduled } = await import("./jobs");

const ENV = {
  APP_BASE_URL: "https://app.example.test",
  MAIL_POSTAL_ADDRESS: "PO Box 1, Hoboken, NJ 07030",
  UNSUBSCRIBE_SECRET: "test-only-secret-0123456789abcdef0123",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "test-token",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM_ADDRESS: "hello@example.test",
  GOOGLE_SHEETS_CLIENT_EMAIL: "intake@kindword-test.iam.gserviceaccount.com",
  GOOGLE_SHEETS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
  GOOGLE_OAUTH_CLIENT_ID: "123-test.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-oauth-client-secret",
  GOOGLE_TOKEN_SECRET: "test-only-google-token-secret-0123456789",
  DRAFT_PROVIDER: "groq",
  GROQ_API_KEY: "gsk_test",
  OPERATOR_EMAIL: "operator@example.test",
};
const msg = (name: string) => ({ name, executionId: "exec-1", scheduledAt: "2026-11-25T12:00:00Z" });

const businessIds: string[] = [];
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  const [b] = await db.insert(s.businesses).values({ name: "Acme Plumbing", vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/t" })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: new Date(), documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  await db
    .insert(s.sheetSources)
    .values({ locationId: l.id, sheetId: "sheet-test", attestationId: a.id, consentWordingVersion: "v1" });
});
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  calls.list = [];
  calls.failPurge = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("dispatch", () => {
  it.each([
    ["sheet-intake", ["pollSheet"]],
    ["review-requests", ["runReviewRequestJobs"]],
    ["reviews", ["pollReviews", "draftPendingReviews", "sendLowRatingAlerts"]],
    ["owner-digest", ["sendDailyDigests"]],
    ["purge", ["purgeExpiredReviews"]],
    ["monthly-report", ["sendMonthlyReports"]],
    ["operator-alerts", ["sendOperatorAlerts"]],
  ])("%s calls its job code", async (job, expected) => {
    await expect(runScheduled(msg(job))).resolves.toBeUndefined();
    expect(calls.list).toEqual(expected);
  });

  it("every schedule in vercel.json names a job, and every message goes to the jobs topic consumer", async () => {
    const { readFile } = await import("node:fs/promises");
    const cfg = JSON.parse(await readFile("vercel.json", "utf8"));
    const { JOBS } = await import("./jobs");
    expect(Object.keys(cfg.schedules).sort()).toEqual(Object.keys(JOBS).sort());
    for (const sch of Object.values(cfg.schedules) as { topic: string }[]) expect(sch.topic).toBe("jobs");
    expect(cfg.functions["src/app/api/jobs/route.ts"].experimentalTriggers).toEqual([
      { type: "queue/v2beta", topic: "jobs", maxDeliveries: MAX_DELIVERIES },
    ]);
  });

  it("acknowledges an unknown or malformed message without running anything", async () => {
    for (const m of [msg("nope"), msg("constructor"), {}, null])
      await expect(runScheduled(m as never)).resolves.toBeUndefined();
    expect(calls.list).toEqual([]);
  });
});

describe("failures and retries", () => {
  it("names a missing setting, never its value, runs the other steps, and does not retry", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    await expect(runScheduled(msg("reviews"))).resolves.toBeUndefined(); // acknowledged: a retry cannot fix it
    expect(calls.list).toEqual(["draftPendingReviews", "sendLowRatingAlerts"]);
    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(line).toContain("GOOGLE_OAUTH_CLIENT_ID missing or not an OAuth client ID");
    expect(line).not.toContain(ENV.GOOGLE_OAUTH_CLIENT_SECRET);
  });

  it("does not run operator alerts without OPERATOR_EMAIL, naming the setting", async () => {
    vi.stubEnv("OPERATOR_EMAIL", "");
    await expect(runScheduled(msg("operator-alerts"))).resolves.toBeUndefined();
    expect(calls.list).toEqual([]);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("OPERATOR_EMAIL missing");
  });

  it("does not send review requests when sending is misconfigured", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    await runScheduled(msg("review-requests"));
    expect(calls.list).toEqual([]);
  });

  it("throws on a transient failure so the queue retries it, logging the error class only", async () => {
    calls.failPurge = true;
    await expect(runScheduled(msg("purge"))).rejects.toBeInstanceOf(JobFailedError);
    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(line).toBe('job purge: failed {"purge":{"error":"Error"}}');
  });

  it("backs off 30 s, 1, 2, 4, 8 min, then gives up", () => {
    const e = new JobFailedError("purge");
    expect([1, 2, 3, 4, 5].map((n) => retryPolicy(e, { deliveryCount: n }))).toEqual(
      [30, 60, 120, 240, 480].map((afterSeconds) => ({ afterSeconds })),
    );
    expect(retryPolicy(e, { deliveryCount: MAX_DELIVERIES })).toEqual({ acknowledge: true });
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toBe("job purge: giving up after 6 deliveries");
  });
});
