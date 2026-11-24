// Waitlist form through the real route handler, against the Postgres in DATABASE_URL. Fake data only:
// @wait.example.test emails and a fake email provider.
import { eq, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { routeDeps } from "../../../accounts/http";
import { db } from "../../../db/client";
import * as s from "../../../db/schema";
import type { EmailMessage } from "../../../email/provider";
import { isMapsUrl } from "../../../waitlist/waitlist";
import { POST } from "./route";

const BASE = "https://reviews.example.test";
const RUN = Date.now().toString(36); // rate-limit rows outlive a run; a fresh "IP" per run and test
let ip = 0;
const good = {
  name: "Pat Example",
  business: "Example Plumbing",
  email: "Pat@wait.example.test",
  maps: "https://maps.app.goo.gl/abc123",
  kind: "Residential plumbing",
};
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  POST(
    new Request(`${BASE}/api/waitlist`, {
      method: "POST",
      headers: { accept: "application/json", origin: BASE, "x-real-ip": `wait-${RUN}-${ip}`, ...headers },
      body: new URLSearchParams(fields),
    }),
  );

let sent: EmailMessage[];
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(() => {
  ip++;
  sent = [];
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.spyOn(routeDeps, "make").mockImplementation(() => ({
    email: { send: async (m: EmailMessage) => void sent.push(m) },
    breach: { isBreached: async () => false },
    baseUrl: BASE,
    operatorEmail: "ops@wait.example.test",
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.delete(s.waitlistEntries).where(like(s.waitlistEntries.normalizedEmail, "%@wait.example.test"));
});

describe("isMapsUrl", () => {
  it.each([
    "https://maps.app.goo.gl/abc123",
    "https://www.google.com/maps/place/Example+Plumbing/@40.7,-74.0,17z",
    "https://maps.google.com/?cid=123",
    "https://goo.gl/maps/xyz",
    "https://g.page/example-plumbing",
    "https://www.google.co.uk/maps/place/x",
  ])("accepts %s", (u) => expect(isMapsUrl(u)).toBe(true));
  it.each([
    "https://example.com/maps",
    "https://www.google.com/search?q=plumber",
    "https://maps.google.com.evil.example/x",
    "javascript:alert(1)",
    "maps.app.goo.gl/abc",
    "https://google.evil.example/maps",
    "",
  ])("rejects %s", (u) => expect(isMapsUrl(u)).toBe(false));
});

describe("POST /api/waitlist", () => {
  it("stores the entry and tells the operator", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(s.waitlistEntries)
      .where(eq(s.waitlistEntries.normalizedEmail, "pat@wait.example.test"));
    expect(row).toMatchObject({ businessName: "Example Plumbing", mapsUrl: good.maps, businessKind: good.kind });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@wait.example.test");
    expect(sent[0].text).toContain(good.maps);
  });

  it("updates the row when the same email joins again", async () => {
    await post(good);
    await post({ ...good, email: "pat@WAIT.example.test", kind: "Plumbing and heating" });
    const rows = await db
      .select()
      .from(s.waitlistEntries)
      .where(eq(s.waitlistEntries.normalizedEmail, "pat@wait.example.test"));
    expect(rows).toHaveLength(1);
    expect(rows[0].businessKind).toBe("Plumbing and heating");
  });

  it.each([
    ["maps", "https://example.com/my-shop"],
    ["kind", "   "],
    ["email", "not-an-email"],
    ["name", ""],
  ])("rejects a bad %s and stores nothing", async (k, v) => {
    const res = await post({ ...good, [k]: v });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
    expect(
      await db.select().from(s.waitlistEntries).where(like(s.waitlistEntries.normalizedEmail, "%@wait.example.test")),
    ).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("refuses cross-site posts", async () => {
    const res = await post(good, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("rate-limits one address", async () => {
    for (let i = 0; i < 5; i++) expect((await post({ ...good, email: `p${i}@wait.example.test` })).status).toBe(200);
    expect((await post({ ...good, email: "p9@wait.example.test" })).status).toBe(429);
  });

  it("answers a no-script form post with a page", async () => {
    const res = await post(good, { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
