// Outside "jobs ran" check (SPEC Stack, Monitoring): run records, per-job lateness and the public status route.
// Runs against the Postgres in DATABASE_URL. job_runs is emptied before each test; audit_log (the pre-job_runs record,
// still read during the transition) is append-only, so each test works in its own random far-future week: audit rows
// from other tests and earlier runs fall outside the 7-day lookback. Fake data only.
import { readFile } from "node:fs/promises";
import { and, eq, gte, lte } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { JOB_MAX_AGE_MS, JOB_RUN_ACTIONS, jobsStatus, recordJobRun } from "./status";

vi.mock("next/server", () => ({ connection: async () => {} }));
const { GET } = await import("../app/api/status/jobs/route");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NAMES = Object.keys(JOB_MAX_AGE_MS);
let now: Date;
const ago = (ms: number) => new Date(now.getTime() - ms);
const recordAll = (at: Date) => Promise.all(NAMES.map((n) => recordJobRun(n, true, db, at)));

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  await db.delete(s.jobRuns);
  now = new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 100_000) * 14 * 24 * HOUR);
  vi.useFakeTimers({ toFake: ["Date"], now });
  return () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  };
});
afterAll(() => db.$client.end());

describe("limits", () => {
  it("covers exactly the jobs in vercel.json, each allowing a missed run plus retries", async () => {
    const cfg = JSON.parse(await readFile("vercel.json", "utf8"));
    expect([...NAMES].sort()).toEqual(Object.keys(cfg.schedules).sort());
    for (const [name, { schedule }] of Object.entries(cfg.schedules) as [string, { schedule: string }][]) {
      const [minute, hour] = schedule.split(" ");
      const interval = minute.startsWith("*/") ? Number(minute.slice(2)) * MIN : hour === "*" ? HOUR : 24 * HOUR;
      expect(JOB_MAX_AGE_MS[name], name).toBeGreaterThanOrEqual(interval + 45 * MIN);
    }
  });
});

describe("recordJobRun", () => {
  it("keeps one row per job with the latest run only, writing nothing to audit_log (O-62-1)", async () => {
    await recordJobRun("reviews", true, db, ago(30 * MIN));
    await recordJobRun("reviews", false, db, ago(5 * MIN));
    await recordJobRun("reviews", true, db, ago(20 * MIN)); // an overlapping retry finishing late
    const rows = await db.select().from(s.jobRuns).where(eq(s.jobRuns.name, "reviews"));
    expect(rows).toEqual([{ name: "reviews", lastRunAt: ago(5 * MIN), lastResult: "failed" }]);
    const audit = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entity, "job"), gte(s.auditLog.at, ago(HOUR)), lte(s.auditLog.at, now)));
    expect(audit).toHaveLength(0);
  });

  it("replaces a stored run more than an hour ahead of a new run (a clock error)", async () => {
    await recordJobRun("purge", true, db, new Date(now.getTime() + 365 * 24 * HOUR));
    await recordJobRun("purge", false, db, now);
    const [row] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.name, "purge"));
    expect(row).toMatchObject({ lastRunAt: now, lastResult: "failed" });
  });
});

describe("jobsStatus", () => {
  it("is not ok when no job has run, naming every job as never", async () => {
    const st = await jobsStatus(now, db);
    expect(st.ok).toBe(false);
    expect(Object.keys(st.jobs).sort()).toEqual([...NAMES].sort());
    for (const j of Object.values(st.jobs)) expect(j).toEqual({ state: "never", lastRunAt: null, lastResult: null });
  });

  it("is ok when every job ran within its limit", async () => {
    await recordAll(ago(10 * MIN));
    const st = await jobsStatus(now, db);
    expect(st.ok).toBe(true);
    expect(st.jobs.reviews).toEqual({ state: "ok", lastRunAt: ago(10 * MIN).toISOString(), lastResult: "ok" });
  });

  it("reports a job late once its limit has passed, at each job's own limit", async () => {
    await recordAll(ago(2 * HOUR));
    const st = await jobsStatus(now, db);
    expect(st.ok).toBe(false);
    expect(st.jobs.reviews.state).toBe("late"); // 15-minute job, 1-hour limit
    expect(st.jobs["sheet-intake"].state).toBe("late");
    expect(st.jobs["owner-digest"].state).toBe("ok"); // hourly job, 3-hour limit
    expect(st.jobs.purge.state).toBe("ok"); // daily job, 26-hour limit
  });

  it("is ok exactly at the limit and late just after it", async () => {
    await recordJobRun("purge", true, db, ago(26 * HOUR));
    expect((await jobsStatus(now, db)).jobs.purge.state).toBe("ok");
    expect((await jobsStatus(new Date(now.getTime() + 1), db)).jobs.purge.state).toBe("late");
  });

  it("counts a failed run as a run, and shows the latest result", async () => {
    await recordAll(ago(30 * MIN));
    await recordJobRun("review-requests", false, db, ago(5 * MIN));
    await recordJobRun("reviews", false, db, ago(40 * MIN)); // older than its ok run
    const st = await jobsStatus(now, db);
    expect(st.ok).toBe(true);
    expect(st.jobs["review-requests"]).toMatchObject({ state: "ok", lastResult: "failed" });
    expect(st.jobs.reviews).toMatchObject({ state: "ok", lastResult: "ok" });
  });

  it("ignores other audit rows, runs in the future of the check, and runs older than the lookback", async () => {
    await db.insert(s.auditLog).values([
      { entity: "job", action: "something_else", actor: "system:jobs", detail: "job=reviews", at: ago(MIN) },
      { entity: "location", action: JOB_RUN_ACTIONS.ok, actor: "system:jobs", detail: "job=reviews", at: ago(MIN) },
    ]);
    await db.insert(s.auditLog).values({
      entity: "job",
      action: JOB_RUN_ACTIONS.ok,
      actor: "system:jobs",
      detail: "job=purge",
      at: ago(8 * 24 * HOUR),
    });
    await recordJobRun("monthly-report", true, db, new Date(now.getTime() + MIN)); // ahead of the check's clock
    const st = await jobsStatus(now, db);
    expect(st.jobs.reviews.state).toBe("never");
    expect(st.jobs.purge.state).toBe("never");
    expect(st.jobs["monthly-report"].state).toBe("never");
  });

  it("still counts runs recorded in audit_log before job_runs existed (transition)", async () => {
    await db.insert(s.auditLog).values({
      entity: "job",
      action: JOB_RUN_ACTIONS.ok,
      actor: "system:jobs",
      detail: "job=purge",
      at: ago(HOUR),
    });
    expect((await jobsStatus(now, db)).jobs.purge).toMatchObject({ state: "ok", lastResult: "ok" });
    await recordJobRun("purge", false, db, ago(MIN));
    expect((await jobsStatus(now, db)).jobs.purge).toMatchObject({ state: "ok", lastResult: "failed" });
  });
});

describe("GET /api/status/jobs", () => {
  it("answers 200 with job states when every job ran, never cached", async () => {
    await recordAll(ago(MIN));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checkedAt).toBe(now.toISOString());
    expect(body.jobs.reviews).toEqual({ state: "ok", lastRunAt: ago(MIN).toISOString() }); // no results shown
  });

  it("answers 503 when a job is late", async () => {
    await recordAll(ago(MIN));
    vi.setSystemTime(new Date(now.getTime() + 2 * HOUR)); // checked 2 hours after every job ran
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.jobs.reviews.state).toBe("late");
    expect(body.jobs.purge.state).toBe("ok");
  });

  it("answers 503 with no details when the database cannot be read", async () => {
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("connection refused at postgres://user:secret@host");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
    expect(err.mock.calls.flat().join(" ")).not.toContain("secret");
  });
});
