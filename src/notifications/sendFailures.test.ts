// Failure records for owner emails and opt-out confirmations: short, safe error codes and best-effort writes.
// Runs against the Postgres in DATABASE_URL. Fake data only.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { ResendSendError } from "../email/resend";
import { TwilioSendError } from "../sms/twilio";
import { failureCode, recordOptOutConfirmationFailure, recordOwnerEmailFailure } from "./sendFailures";

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$client.end());

describe("failureCode", () => {
  it("keeps provider status and codes, names bad time zones, and falls back to the class name", () => {
    expect(failureCode(new ResendSendError(422, "validation_error", false))).toBe("email_validation_error");
    expect(failureCode(new ResendSendError(0, null, true))).toBe("email_status_0");
    expect(failureCode(new TwilioSendError(400, 21211))).toBe("sms_21211");
    expect(failureCode(new TwilioSendError(503, null))).toBe("sms_status_503");
    let tzError: unknown;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: "Not/AZone" });
    } catch (e) {
      tzError = e;
    }
    expect(failureCode(tzError)).toBe("bad_time_zone");
    expect(failureCode(new TypeError("pat@example.test"))).toBe("TypeError");
  });

  it("never passes through an error's message or an odd name", () => {
    const odd = new Error("x");
    odd.name = "to=pat@example.test";
    expect(failureCode(odd)).toBe("unknown");
    expect(failureCode("pat@example.test")).toBe("unknown");
    expect(failureCode(null)).toBe("unknown");
  });
});

describe("records", () => {
  it("writes one owner-email failure row with the location, kind, period and code", async () => {
    const locationId = randomUUID();
    await recordOwnerEmailFailure({ locationId, kind: "digest", period: "2026-11-25", error: new Error("x") });
    const rows = await db.select().from(s.auditLog).where(eq(s.auditLog.locationId, locationId));
    expect(
      rows.map(({ entity, entityId, action, actor, detail }) => ({ entity, entityId, action, actor, detail })),
    ).toEqual([
      {
        entity: "location",
        entityId: locationId,
        action: "owner_email_failed",
        actor: "system:send_failure",
        detail: "kind=digest;period=2026-11-25;error=Error",
      },
    ]);
  });

  it("writes an opt-out confirmation failure with no location when the number is unknown", async () => {
    const before = new Date(Date.now() - 1000);
    await recordOptOutConfirmationFailure(null, new TwilioSendError(500, null));
    const rows = await db
      .select({ detail: s.auditLog.detail, at: s.auditLog.at })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, "opt_out_confirmation_failed"), eq(s.auditLog.detail, "error=sms_status_500")));
    expect(rows.some((r) => r.at >= before)).toBe(true);
  });

  it("swallows a database failure so the send path is unchanged", async () => {
    vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("connection reset");
    });
    await expect(
      recordOwnerEmailFailure({ locationId: randomUUID(), kind: "low_rating", period: "2026-11-25", error: null }),
    ).resolves.toBeUndefined();
    await expect(recordOptOutConfirmationFailure(null, null)).resolves.toBeUndefined();
  });
});
