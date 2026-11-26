// The scheduled-job route: auth, dispatch to each job's existing code (mocked here), and that one failing step does
// not stop the others. Runs against the Postgres in DATABASE_URL for the sheet-source lookup. Fake data only.
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../../db/client";
import * as s from "../../../../db/schema";

const calls = vi.hoisted(() => ({ list: [] as string[] }));
const track =
  <T>(name: string, value: T) =>
  async (...args: unknown[]) => {
    calls.list.push(name);
    void args;
    return value;
  };
vi.mock("../../../../intake/pollSheet", () => ({ pollSheet: track("pollSheet", { ok: true, rows: [] }) }));
vi.mock("../../../../requests/requests", async (orig) => ({
  ...(await orig<object>()),
  runReviewRequestJobs: track("runReviewRequestJobs", {
    scheduled: { scheduled: 0, skipped: {} },
    reminders: { scheduled: 0 },
    sent: { sent: 0, failed: 0, deferred: 0, waiting: 0, skipped: {} },
  }),
}));
vi.mock("../../../../reviews/poll", () => ({
  pollReviews: track("pollReviews", { locations: 0, newReviews: 0, failed: [] }),
}));
vi.mock("../../../../reviews/draft", () => ({ draftPendingReviews: track("draftPendingReviews", { drafted: 0 }) }));
vi.mock("../../../../notifications/ownerEmails", () => ({
  sendLowRatingAlerts: track("sendLowRatingAlerts", { sent: 0, failed: 0 }),
  sendDailyDigests: track("sendDailyDigests", { sent: 0, failed: 0 }),
}));
vi.mock("../../../../reviews/purge", () => ({
  purgeExpiredReviews: track("purgeExpiredReviews", { reviews: 0, drafts: 0, cutoff: new Date() }),
}));

const { POST } = await import("./route");

const SECRET = "test-only-cron-secret-0123456789";
const call = (job: string, auth: string | null = `Bearer ${SECRET}`) =>
  POST(
    new Request(`https://app.example.test/api/jobs/${job}`, {
      method: "POST",
      headers: auth === null ? {} : { authorization: auth },
    }),
    { params: Promise.resolve({ job }) },
  );

const ENV = {
  CRON_SECRET: SECRET,
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
  GOOGLE_OAUTH_CLIENT_SECRET: "test",
  GOOGLE_TOKEN_SECRET: "test-only-google-token-secret-0123456789",
  DRAFT_PROVIDER: "groq",
  GROQ_API_KEY: "gsk_test",
};

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
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  calls.list = [];
});
afterAll(async () => {
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("auth", () => {
  it.each([
    ["no header", null],
    ["wrong secret", "Bearer not-the-secret-000000000"],
    ["secret without Bearer", SECRET],
  ])("rejects %s with 401 and runs nothing", async (_, auth) => {
    expect((await call("purge", auth)).status).toBe(401);
    expect(calls.list).toEqual([]);
  });

  it("rejects everything when CRON_SECRET is unset or too short (a preview without the secret)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("purge", "Bearer ")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await call("purge", "Bearer short")).status).toBe(401);
    expect(calls.list).toEqual([]);
  });

  it("404s an unknown job, including Object prototype names", async () => {
    expect((await call("nope")).status).toBe(404);
    expect((await call("constructor")).status).toBe(404);
  });
});

describe("dispatch", () => {
  it.each([
    ["sheet-intake", ["pollSheet"]],
    ["review-requests", ["runReviewRequestJobs"]],
    ["reviews", ["pollReviews", "draftPendingReviews", "sendLowRatingAlerts"]],
    ["owner-digest", ["sendDailyDigests"]],
    ["purge", ["purgeExpiredReviews"]],
  ])("%s calls its job code", async (job, expected) => {
    const res = await call(job);
    expect(res.status).toBe(200);
    expect(calls.list).toEqual(expected);
    expect((await res.json()).ok).toBe(true);
  });

  it("names a missing setting, never its value, and still runs the other steps", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("reviews");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.steps.poll).toEqual({ error: "GOOGLE_OAUTH_CLIENT_ID missing or not an OAuth client ID" });
    expect(calls.list).toEqual(["draftPendingReviews", "sendLowRatingAlerts"]);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).not.toContain(ENV.GOOGLE_OAUTH_CLIENT_SECRET);
    error.mockRestore();
  });

  it("does not send review requests when sending is misconfigured", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("review-requests");
    expect(res.status).toBe(500);
    expect(calls.list).toEqual([]);
  });
});
