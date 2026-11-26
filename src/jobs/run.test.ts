// End to end through the scheduled-job handler (what the queue consumer runs) with the real job code and the real Twilio and Resend adapters; only
// their HTTP calls are faked (global fetch). Runs against the Postgres in DATABASE_URL. Fake data only: 555-01xx
// numbers, example.test emails. No live sends.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { runScheduled } from "./jobs";

const PHONE = "+12015550112";
const NUMBER = "+12015550182";
// 10:00 a.m. New York time on a Monday; the request is due at noon, inside the send window.
const VISIT = new Date("2026-11-23T15:00:00Z");
const NOW = new Date("2026-11-23T17:05:00Z");

const run = (name: string) => runScheduled({ name, executionId: "exec-1", scheduledAt: NOW.toISOString() });

let outbound: string[];
const businessIds: string[] = [];

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  for (const [k, v] of Object.entries({
    APP_BASE_URL: "https://app.example.test",
    MAIL_POSTAL_ADDRESS: "PO Box 1, Hoboken, NJ 07030",
    UNSUBSCRIBE_SECRET: "test-only-secret-0123456789abcdef0123",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "test-token",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM_ADDRESS: "hello@example.test",
  }))
    vi.stubEnv(k, v);
  outbound = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      outbound.push(new URL(url).host);
      return Response.json({ sid: `SM${outbound.length}`, id: `em_${outbound.length}` }, { status: 201 });
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds.splice(0)));
});
afterAll(() => db.$client.end());

it("review-requests sends a due text once, even when the run repeats or overlaps", async () => {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: "Acme Plumbing", vertical: "plumbing", status: "live" })
    .returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/acme/review",
      smsNumber: NUMBER,
    })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: VISIT, documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  const [c] = await db
    .insert(s.customers)
    .values({
      locationId: l.id,
      businessId: b.id,
      phone: PHONE,
      normalizedPhone: PHONE,
      consentMethod: "signed_estimate",
      consentWordingVersion: "v1",
      consentAt: new Date("2026-11-01T15:00:00Z"),
      consentEvidenceRef: "estimate-0001.pdf",
      attestationId: a.id,
    })
    .returning();
  const [v] = await db
    .insert(s.visits)
    .values({ customerId: c.id, locationId: l.id, visitAt: VISIT, source: "csv", externalVisitId: "jobs-1" })
    .returning();

  // Two overlapping runs (a redelivery racing the original), then a retry.
  await Promise.all([run("review-requests"), run("review-requests")]);
  await run("review-requests");

  expect(outbound).toEqual(["api.twilio.com"]);
  const rows = await db.select().from(s.reviewRequests).where(eq(s.reviewRequests.visitId, v.id));
  expect(rows.map((r) => [r.attempt, r.channel, r.status])).toEqual([[1, "sms", "sent"]]);

  // The log line is counts only: no phone number or message text.
  const logged = vi.mocked(console.log).mock.calls.map((x) => String(x[0]));
  expect(logged).toHaveLength(3);
  for (const line of logged) {
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain("Acme");
  }
});

it("optout-confirmations is redelivered while a confirmation is open, then sends it once (audit F-9-2)", async () => {
  const [b] = await db.insert(s.businesses).values({ name: "Acme Plumbing", vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/a",
      smsNumber: NUMBER,
    })
    .returning();
  const [sup] = await db
    .insert(s.suppressionList)
    .values({ locationId: l.id, channel: "sms", address: PHONE, source: "customer_sms" })
    .returning();
  await db
    .insert(s.optOutConfirmations)
    .values({ suppressionId: sup.id, locationId: l.id, fromNumber: NUMBER, status: "pending" });
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: 21211 }, { status: 400 })); // refused
  await expect(run("optout-confirmations")).rejects.toThrow("optout-confirmations"); // handed to retryPolicy
  await run("optout-confirmations");
  await run("optout-confirmations");

  expect(outbound).toEqual(["api.twilio.com"]); // the refused call bypassed `outbound`; one text went out
  const [row] = await db.select().from(s.optOutConfirmations).where(eq(s.optOutConfirmations.suppressionId, sup.id));
  expect(row).toMatchObject({ status: "sent", attempts: 3 });
});
