// Runs against the Postgres in DATABASE_URL. Each test runs in a transaction that is rolled back.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "./schema";

const client = new Client({ connectionString: process.env.DATABASE_URL });
let db: NodePgDatabase<typeof s>;
let locationId: string;
let businessId: string;
let attestationId: string;
let other: Awaited<ReturnType<typeof makeTenant>>; // a second business, for cross-tenant tests

const consent = () => ({
  consentMethod: "signed_estimate" as const,
  consentWordingVersion: "v1",
  consentAt: new Date("2026-11-01T15:00:00Z"),
  consentEvidenceRef: "estimate-0001.pdf",
  attestationId,
});
const phone = { phone: "(201) 555-0100", normalizedPhone: "+12015550100" };

// Runs q inside a savepoint so the test transaction survives the expected error.
async function failure(q: () => Promise<unknown>) {
  await client.query("savepoint expect_fail");
  const err = await q().then(
    () => null,
    (e) => e,
  );
  await client.query(err ? "rollback to savepoint expect_fail" : "release savepoint expect_fail");
  return err;
}

// Postgres reports the violated constraint on the error's cause.
async function rejects(q: () => Promise<unknown>, constraint: string) {
  const err = await failure(q);
  expect(err, `expected ${constraint} violation`).not.toBeNull();
  expect(err.cause?.constraint ?? err.constraint).toBe(constraint);
}

beforeAll(async () => {
  await client.connect();
  db = drizzle(client, { schema: s });
  await migrate(db, { migrationsFolder: "./drizzle" });
});
afterAll(() => client.end());

async function makeTenant(name: string) {
  const [b] = await db.insert(s.businesses).values({ name, vertical: "plumbing" }).returning();
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/test",
    })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({
      businessId: b.id,
      signedAt: new Date(),
      documentRef: "attest.pdf",
      listDescription: "signed estimates",
    })
    .returning();
  return { businessId: b.id, locationId: l.id, attestationId: a.id };
}

beforeEach(async () => {
  await client.query("begin");
  ({ businessId, locationId, attestationId } = await makeTenant("Test Plumbing"));
  other = await makeTenant("Other HVAC");
});
afterEach(() => client.query("rollback"));

describe("customers: phone requires consent", () => {
  it("accepts a phone with a full consent record", async () => {
    await db.insert(s.customers).values({ locationId, businessId, ...phone, ...consent() });
  });

  it("accepts email only, no consent", async () => {
    await db.insert(s.customers).values({
      locationId,
      businessId,
      email: "A@x.test",
      normalizedEmail: "a@x.test",
    });
  });

  it("rejects a phone with no consent record", async () => {
    await rejects(() => db.insert(s.customers).values({ locationId, businessId, ...phone }), "phone_requires_consent");
  });

  it("rejects a phone with only an attestation (not a consent record, FR-3)", async () => {
    await rejects(
      () => db.insert(s.customers).values({ locationId, businessId, ...phone, attestationId }),
      "phone_requires_consent",
    );
  });

  for (const field of [
    "consentMethod",
    "consentWordingVersion",
    "consentAt",
    "consentEvidenceRef",
    "attestationId",
  ] as const) {
    it(`rejects a phone when ${field} is missing`, async () => {
      await rejects(
        () =>
          db.insert(s.customers).values({
            locationId,
            businessId,
            ...phone,
            ...consent(),
            [field]: null,
          }),
        "phone_requires_consent",
      );
    });
  }

  it("rejects adding a phone later via update without consent", async () => {
    const [c] = await db
      .insert(s.customers)
      .values({ locationId, businessId, email: "b@x.test", normalizedEmail: "b@x.test" })
      .returning();
    await rejects(
      () =>
        client.query("update customers set phone = $1, normalized_phone = $2 where id = $3", [
          "2015550100",
          "+12015550100",
          c.id,
        ]),
      "phone_requires_consent",
    );
  });

  it("rejects a normalized phone without the raw phone (no bypass of dedup or consent)", async () => {
    await rejects(
      () =>
        db.insert(s.customers).values({
          locationId,
          businessId,
          normalizedPhone: "+12015550100",
          email: "c@x.test",
          normalizedEmail: "c@x.test",
        }),
      "phone_normalized",
    );
  });
});

describe("customers: dedup", () => {
  it("rejects a duplicate (location, normalized phone)", async () => {
    await db.insert(s.customers).values({ locationId, businessId, ...phone, ...consent() });
    await rejects(
      () =>
        db.insert(s.customers).values({
          locationId,
          businessId,
          phone: "201-555-0100",
          normalizedPhone: "+12015550100",
          ...consent(),
        }),
      "customers_location_id_normalized_phone_unique",
    );
  });

  it("rejects a duplicate (location, normalized email)", async () => {
    await db.insert(s.customers).values({
      locationId,
      businessId,
      email: "a@x.test",
      normalizedEmail: "a@x.test",
    });
    await rejects(
      () =>
        db.insert(s.customers).values({
          locationId,
          businessId,
          email: "A@X.test",
          normalizedEmail: "a@x.test",
        }),
      "customers_location_id_normalized_email_unique",
    );
  });
});

describe("suppression_list uniqueness", () => {
  const entry = {
    channel: "sms" as const,
    address: "+12015550100",
    source: "inbound_stop",
  };

  it("rejects a duplicate per-client entry", async () => {
    await db.insert(s.suppressionList).values({ locationId, ...entry });
    await rejects(
      () => db.insert(s.suppressionList).values({ locationId, ...entry }),
      "suppression_list_location_id_channel_address_unique",
    );
  });

  it("rejects a duplicate platform-wide (null location) entry", async () => {
    await db.insert(s.suppressionList).values({ locationId: null, ...entry });
    await rejects(
      () => db.insert(s.suppressionList).values({ locationId: null, ...entry }),
      "suppression_list_location_id_channel_address_unique",
    );
  });

  it("allows the same address per-client and platform-wide, and on another channel", async () => {
    await db.insert(s.suppressionList).values([
      { locationId, ...entry },
      { locationId: null, ...entry },
      { locationId: null, ...entry, channel: "email", address: "a@x.test" },
    ]);
  });
});

describe("tenant scoping", () => {
  it("rejects a customer whose business does not own the location", async () => {
    await rejects(
      () =>
        db.insert(s.customers).values({
          locationId,
          businessId: other.businessId,
          email: "a@x.test",
          normalizedEmail: "a@x.test",
        }),
      "customers_location_fk",
    );
  });

  it("rejects a phone consented under another business's attestation", async () => {
    await rejects(
      () =>
        db.insert(s.customers).values({
          locationId,
          businessId,
          ...phone,
          ...consent(),
          attestationId: other.attestationId,
        }),
      "customers_attestation_fk",
    );
  });

  async function reviewAndSession(loc: string) {
    const [r] = await db
      .insert(s.reviews)
      .values({ locationId: loc, googleReviewId: `g-${loc}`, rating: 5 })
      .returning();
    const [o] = await db
      .insert(s.ownerSessions)
      .values({
        locationId: loc,
        ownerEmail: "o@x.test",
        loginTokenHash: `h-${loc}`,
        tokenExpiresAt: new Date(),
      })
      .returning();
    return { reviewId: r.id, sessionId: o.id };
  }
  const draft = { draftText: "Thanks!", model: "test", promptVersion: 1 };

  it("accepts approval by a session for the draft's own location", async () => {
    const { reviewId, sessionId } = await reviewAndSession(locationId);
    await db.insert(s.replyDrafts).values({
      ...draft,
      reviewId,
      locationId,
      approvedSessionId: sessionId,
      approvedAt: new Date(),
    });
  });

  it("rejects approval by another location's owner session", async () => {
    const { reviewId } = await reviewAndSession(locationId);
    const { sessionId: otherSession } = await reviewAndSession(other.locationId);
    await rejects(
      () =>
        db.insert(s.replyDrafts).values({
          ...draft,
          reviewId,
          locationId,
          approvedSessionId: otherSession,
          approvedAt: new Date(),
        }),
      "reply_drafts_session_fk",
    );
  });

  it("rejects a draft whose location does not match its review", async () => {
    const { reviewId } = await reviewAndSession(locationId);
    await rejects(
      () => db.insert(s.replyDrafts).values({ ...draft, reviewId, locationId: other.locationId }),
      "reply_drafts_review_fk",
    );
  });

  it("rejects an approval with no session recorded", async () => {
    const { reviewId } = await reviewAndSession(locationId);
    await rejects(
      () => db.insert(s.replyDrafts).values({ ...draft, reviewId, locationId, approvedAt: new Date() }),
      "approved_requires_session",
    );
  });

  it("deleting a business cascades through approved drafts and sessions", async () => {
    const { reviewId, sessionId } = await reviewAndSession(locationId);
    await db.insert(s.replyDrafts).values({
      ...draft,
      reviewId,
      locationId,
      approvedSessionId: sessionId,
      approvedAt: new Date(),
    });
    await db.insert(s.customers).values({ locationId, businessId, ...phone, ...consent() });
    await client.query("delete from businesses where id = $1", [businessId]);
    const { rows } = await client.query("select count(*)::int as n from reply_drafts");
    expect(rows[0].n).toBe(0);
  });
});

describe("remaining constraints", () => {
  async function visit(externalVisitId = "row-1") {
    const [c] = await db
      .insert(s.customers)
      .values({
        locationId,
        businessId,
        email: `${externalVisitId}@x.test`,
        normalizedEmail: `${externalVisitId}@x.test`,
      })
      .returning();
    const [v] = await db
      .insert(s.visits)
      .values({ customerId: c.id, locationId, visitAt: new Date(), source: "csv", externalVisitId })
      .returning();
    return v.id;
  }
  const request = (visitId: string) => ({ visitId, scheduledFor: new Date(), channel: "email" as const, attempt: 1 });
  const review = (googleReviewId = "g-1") => ({ locationId, googleReviewId, rating: 5 });

  it("rejects an owner phone without a contact consent ref", async () => {
    await rejects(
      () => db.insert(s.businesses).values({ name: "B", vertical: "hvac", ownerPhone: "+12015550101" }),
      "owner_phone_requires_consent",
    );
    await db
      .insert(s.businesses)
      .values({ name: "B", vertical: "hvac", ownerPhone: "+12015550101", ownerContactConsentRef: "msa.pdf" });
  });

  it("rejects attempt other than 1 or 2", async () => {
    const visitId = await visit();
    await rejects(() => db.insert(s.reviewRequests).values({ ...request(visitId), attempt: 3 }), "attempt_1_or_2");
  });

  it("requires skip_reason exactly when status is skipped", async () => {
    const visitId = await visit();
    await rejects(
      () => db.insert(s.reviewRequests).values({ ...request(visitId), status: "skipped" }),
      "skip_reason_iff_skipped",
    );
    await rejects(
      () => db.insert(s.reviewRequests).values({ ...request(visitId), skipReason: "stale" }),
      "skip_reason_iff_skipped",
    );
    await db.insert(s.reviewRequests).values({ ...request(visitId), status: "skipped", skipReason: "stale" });
  });

  it("rejects a duplicate (visit, channel, attempt) but allows the reminder", async () => {
    const visitId = await visit();
    await db.insert(s.reviewRequests).values(request(visitId));
    await db.insert(s.reviewRequests).values({ ...request(visitId), attempt: 2 });
    await rejects(
      () => db.insert(s.reviewRequests).values(request(visitId)),
      "review_requests_visit_id_channel_attempt_unique",
    );
  });

  it("rejects a duplicate (location, source, external visit id)", async () => {
    await visit("row-1");
    const [c] = await db.select().from(s.customers);
    await rejects(
      () =>
        db
          .insert(s.visits)
          .values({ customerId: c.id, locationId, visitAt: new Date(), source: "csv", externalVisitId: "row-1" }),
      "visits_location_id_source_external_visit_id_unique",
    );
    await db
      .insert(s.visits)
      .values({ customerId: c.id, locationId, visitAt: new Date(), source: "sheet", externalVisitId: "row-1" });
  });

  it("rejects a rating outside 1 to 5", async () => {
    await rejects(() => db.insert(s.reviews).values({ ...review(), rating: 0 }), "rating_1_to_5");
    await rejects(() => db.insert(s.reviews).values({ ...review(), rating: 6 }), "rating_1_to_5");
  });

  it("rejects a duplicate google_review_id", async () => {
    await db.insert(s.reviews).values(review());
    await rejects(() => db.insert(s.reviews).values(review()), "reviews_google_review_id_unique");
  });

  describe("reply drafts", () => {
    async function setup() {
      const [r] = await db.insert(s.reviews).values(review()).returning();
      const [o] = await db
        .insert(s.ownerSessions)
        .values({ locationId, ownerEmail: "o@x.test", loginTokenHash: "h", tokenExpiresAt: new Date() })
        .returning();
      const posted = {
        reviewId: r.id,
        locationId,
        draftText: "Thanks!",
        model: "test",
        promptVersion: 1,
        status: "posted" as const,
        approvedSessionId: o.id,
        approvedAt: new Date(),
        postedAt: new Date(),
      };
      return posted;
    }

    it("rejects posted_at without approval", async () => {
      const posted = await setup();
      await rejects(
        () => db.insert(s.replyDrafts).values({ ...posted, approvedAt: null, approvedSessionId: null }),
        "posted_requires_approval",
      );
    });

    it("allows only one posted reply per review", async () => {
      const posted = await setup();
      await db.insert(s.replyDrafts).values(posted);
      await db.insert(s.replyDrafts).values({ ...posted, status: "rejected", postedAt: null });
      await rejects(() => db.insert(s.replyDrafts).values(posted), "one_posted_reply_per_review");
    });
  });

  it("rejects a second oauth token for a location", async () => {
    const token = { locationId, encryptedRefreshToken: "enc", scopes: ["business.manage"] };
    await db.insert(s.oauthTokens).values(token);
    await rejects(() => db.insert(s.oauthTokens).values(token), "oauth_tokens_location_id_unique");
  });

  it("rejects a second sheet source for a location", async () => {
    await db.insert(s.sheetSources).values({ locationId, sheetId: "sheet-a" });
    await rejects(
      () => db.insert(s.sheetSources).values({ locationId, sheetId: "sheet-b" }),
      "sheet_sources_location_id_unique",
    );
  });

  it("rejects a reused login token hash", async () => {
    const session = { locationId, ownerEmail: "o@x.test", loginTokenHash: "h", tokenExpiresAt: new Date() };
    await db.insert(s.ownerSessions).values(session);
    await rejects(
      () => db.insert(s.ownerSessions).values({ ...session, locationId: other.locationId }),
      "owner_sessions_login_token_hash_unique",
    );
  });

  it("rejects two locations with the same google_location_id", async () => {
    await client.query("update locations set google_location_id = 'gbp-1' where id = $1", [locationId]);
    await rejects(
      () => client.query("update locations set google_location_id = 'gbp-1' where id = $1", [other.locationId]),
      "locations_google_location_id_unique",
    );
  });
});

describe("audit_log is append-only", () => {
  const entry = () => ({ locationId, entity: "review_request", action: "sent", actor: "system" });
  async function blocked(q: () => Promise<unknown>, op: string) {
    const err = await failure(q);
    expect(err?.message).toContain(`audit_log is append-only (${op} rejected)`);
  }

  it("allows insert", async () => {
    await db.insert(s.auditLog).values(entry());
  });

  it("rejects update", async () => {
    await db.insert(s.auditLog).values(entry());
    await blocked(() => client.query("update audit_log set action = 'edited'"), "UPDATE");
  });

  it("rejects delete", async () => {
    await db.insert(s.auditLog).values(entry());
    await blocked(() => client.query("delete from audit_log"), "DELETE");
  });

  it("rejects truncate", async () => {
    await blocked(() => client.query("truncate audit_log"), "TRUNCATE");
  });

  it("survives deleting the business", async () => {
    await db.insert(s.auditLog).values(entry());
    await client.query("delete from businesses where id = $1", [businessId]);
    // Scoped to this location: append-only rows committed by other test files persist across runs.
    const { rows } = await client.query("select count(*)::int as n from audit_log where location_id = $1", [
      locationId,
    ]);
    expect(rows[0].n).toBe(1);
  });
});
