// Runs against the Postgres in DATABASE_URL. Each test runs in a transaction that is rolled back.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "./schema";

const client = new Client({ connectionString: process.env.DATABASE_URL });
let db: NodePgDatabase<typeof s>;
let locationId: string;
let attestationId: string;

const consent = () => ({
  consentMethod: "signed_estimate" as const,
  consentWordingVersion: "v1",
  consentAt: new Date("2026-11-01T15:00:00Z"),
  consentEvidenceRef: "estimate-0001.pdf",
  attestationId,
});
const phone = { phone: "(201) 555-0100", normalizedPhone: "+12015550100" };

// Postgres reports the violated constraint on the error's cause.
async function rejects(p: Promise<unknown>, constraint: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected ${constraint} violation`).not.toBeNull();
  expect(err.cause?.constraint ?? err.constraint).toBe(constraint);
}

beforeAll(async () => {
  await client.connect();
  db = drizzle(client, { schema: s });
  await migrate(db, { migrationsFolder: "./drizzle" });
});
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  const [b] = await db.insert(s.businesses).values({ name: "Test Plumbing", vertical: "plumbing" }).returning();
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/test" })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: new Date(), documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  locationId = l.id;
  attestationId = a.id;
});
afterEach(() => client.query("rollback"));

describe("customers: phone requires consent", () => {
  it("accepts a phone with a full consent record", async () => {
    await db.insert(s.customers).values({ locationId, ...phone, ...consent() });
  });

  it("accepts email only, no consent", async () => {
    await db.insert(s.customers).values({ locationId, email: "A@x.test", normalizedEmail: "a@x.test" });
  });

  it("rejects a phone with no consent record", async () => {
    await rejects(db.insert(s.customers).values({ locationId, ...phone }), "phone_requires_consent");
  });

  it("rejects a phone with only an attestation (not a consent record, FR-3)", async () => {
    await rejects(db.insert(s.customers).values({ locationId, ...phone, attestationId }), "phone_requires_consent");
  });

  for (const field of ["consentMethod", "consentWordingVersion", "consentAt", "consentEvidenceRef", "attestationId"] as const) {
    it(`rejects a phone when ${field} is missing`, async () => {
      await rejects(
        db.insert(s.customers).values({ locationId, ...phone, ...consent(), [field]: null }),
        "phone_requires_consent",
      );
    });
  }

  it("rejects adding a phone later via update without consent", async () => {
    const [c] = await db
      .insert(s.customers)
      .values({ locationId, email: "b@x.test", normalizedEmail: "b@x.test" })
      .returning();
    await rejects(client.query("update customers set phone = $1, normalized_phone = $2 where id = $3", ["2015550100", "+12015550100", c.id]), "phone_requires_consent");
  });

  it("rejects a normalized phone without the raw phone (no bypass of dedup or consent)", async () => {
    await rejects(
      db.insert(s.customers).values({ locationId, normalizedPhone: "+12015550100", email: "c@x.test", normalizedEmail: "c@x.test" }),
      "phone_normalized",
    );
  });
});

describe("customers: dedup", () => {
  it("rejects a duplicate (location, normalized phone)", async () => {
    await db.insert(s.customers).values({ locationId, ...phone, ...consent() });
    await rejects(
      db.insert(s.customers).values({ locationId, phone: "201-555-0100", normalizedPhone: "+12015550100", ...consent() }),
      "customers_location_id_normalized_phone_unique",
    );
  });

  it("rejects a duplicate (location, normalized email)", async () => {
    await db.insert(s.customers).values({ locationId, email: "a@x.test", normalizedEmail: "a@x.test" });
    await rejects(
      db.insert(s.customers).values({ locationId, email: "A@X.test", normalizedEmail: "a@x.test" }),
      "customers_location_id_normalized_email_unique",
    );
  });
});

describe("suppression_list uniqueness", () => {
  const entry = { channel: "sms" as const, address: "+12015550100", source: "inbound_stop" };

  it("rejects a duplicate per-client entry", async () => {
    await db.insert(s.suppressionList).values({ locationId, ...entry });
    await rejects(db.insert(s.suppressionList).values({ locationId, ...entry }), "suppression_list_location_id_channel_address_unique");
  });

  it("rejects a duplicate platform-wide (null location) entry", async () => {
    await db.insert(s.suppressionList).values({ locationId: null, ...entry });
    await rejects(db.insert(s.suppressionList).values({ locationId: null, ...entry }), "suppression_list_location_id_channel_address_unique");
  });

  it("allows the same address per-client and platform-wide, and on another channel", async () => {
    await db.insert(s.suppressionList).values([
      { locationId, ...entry },
      { locationId: null, ...entry },
      { locationId: null, ...entry, channel: "email", address: "a@x.test" },
    ]);
  });
});
