// Outside check that the scheduled jobs run at all (SPEC Stack, Monitoring: "a daily check that jobs ran").
//
// Operator alerts (src/notifications/operatorAlerts.ts) run on Vercel Schedules too, so a full Schedules or Queues
// outage, or a consumer that never starts, would stop the alerts along with everything else. This module records
// the last finished run of each scheduled job in job_runs (one row per job, overwritten each run, so it never grows:
// audit O-62-1), and GET /api/status/jobs reports whether every job has run recently enough. An uptime monitor outside Vercel polls that route and alerts the operator when it answers 503.
//
// "Ran" means the job was delivered and finished a run, whatever its result: a job that runs but fails is already
// visible in the job logs and, for sends and Google access, in operator alerts. This check is about the scheduler.
//
// What is stored and shown: job names, the time of each run and "ok" or "failed". Never personal data, message
// text, review text, setting values or error messages.
import { and, eq, gt, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, jobRuns } from "../db/schema";

const ENTITY = "job";
// Runs used to be one audit_log row each (#62). audit_log is append-only, so those rows cannot be deleted; they are no
// longer written, and are still read for LOOKBACK_MS after this change so the check does not report a job "never" run
// until it next runs (the daily purge, up to a day). The audit read can go in a later PR.
export const JOB_RUN_ACTIONS = { ok: "job_ran", failed: "job_ran_failed" } as const;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// How long each job may go without a run before the check reports it late. Each limit leaves room for several
// missed ticks and the queue's retries, so one slow or dropped delivery does not page anyone:
// - every 15 minutes (vercel.json "*/15 * * * *"): late after 1 hour (4 ticks);
// - hourly ("0 * * * *", "10 * * * *"): late after 3 hours;
// - daily at 06:30 UTC ("30 6 * * *"): late after 26 hours.
// A test keeps this list in step with vercel.json's schedules.
export const JOB_MAX_AGE_MS: Record<string, number> = {
  "sheet-intake": HOUR,
  "review-requests": HOUR,
  reviews: HOUR,
  "operator-alerts": HOUR,
  "optout-confirmations": HOUR,
  "owner-digest": 3 * HOUR,
  "monthly-report": 3 * HOUR,
  purge: 26 * HOUR,
};
// Old audit_log runs older than this are not read: every limit above is shorter, so they cannot change the answer.
const LOOKBACK_MS = 7 * 24 * HOUR;

// Records that a job finished a run. Called by the scheduled-job handler after every run, including retries. A run
// a little older than the stored one (an overlapping retry finishing late; retries span under 20 minutes) does not
// move the time back, but a stored time more than an hour ahead of a new run is a clock error and is replaced, so a
// bad clock can never hide a stopped job for long.
export async function recordJobRun(name: string, ok: boolean, db: Db = defaultDb, now: Date = new Date()) {
  const lastResult = ok ? "ok" : "failed";
  await db
    .insert(jobRuns)
    .values({ name, lastRunAt: now, lastResult })
    .onConflictDoUpdate({
      target: jobRuns.name,
      set: { lastRunAt: now, lastResult },
      setWhere: sql`${jobRuns.lastRunAt} <= ${now.toISOString()}::timestamptz
        or ${jobRuns.lastRunAt} > ${now.toISOString()}::timestamptz + interval '1 hour'`,
    });
}

export type JobState = "ok" | "late" | "never";
export type JobsStatus = {
  ok: boolean;
  checkedAt: string;
  jobs: Record<string, { state: JobState; lastRunAt: string | null; lastResult: "ok" | "failed" | null }>;
};

// Every job in JOB_MAX_AGE_MS with its state. ok is true only when every job has run within its limit; a job with no
// run on record (for example right after the first deploy, until the daily purge has run once) counts as not ok.
export async function jobsStatus(now: Date = new Date(), db: Db = defaultDb): Promise<JobsStatus> {
  const names = Object.keys(JOB_MAX_AGE_MS);
  const latest = new Map<string, { at: Date; result: "ok" | "failed" }>();
  const consider = (name: string, at: Date, result: "ok" | "failed") => {
    if (at > now) return; // a clock ahead of this one must not hide a stopped job
    const seen = latest.get(name);
    if (!seen || at > seen.at) latest.set(name, { at, result });
  };

  const runs = await db.select().from(jobRuns).where(inArray(jobRuns.name, names));
  for (const r of runs) consider(r.name, r.lastRunAt, r.lastResult === "ok" ? "ok" : "failed");

  // Runs recorded in audit_log before job_runs existed (see JOB_RUN_ACTIONS).
  const rows = await db
    .select({ detail: auditLog.detail, action: auditLog.action, at: max(auditLog.at) })
    .from(auditLog)
    .where(
      and(
        isNull(auditLog.locationId), // the (location_id, at) index
        gt(auditLog.at, new Date(now.getTime() - LOOKBACK_MS)),
        lte(auditLog.at, now),
        eq(auditLog.entity, ENTITY),
        inArray(auditLog.action, Object.values(JOB_RUN_ACTIONS)),
        inArray(
          auditLog.detail,
          names.map((n) => `job=${n}`),
        ),
      ),
    )
    .groupBy(auditLog.detail, auditLog.action);
  for (const r of rows) {
    if (!r.detail || !r.at) continue;
    consider(r.detail.slice("job=".length), r.at, r.action === JOB_RUN_ACTIONS.ok ? "ok" : "failed");
  }

  const jobs: JobsStatus["jobs"] = {};
  for (const name of names) {
    const last = latest.get(name);
    const state: JobState = !last ? "never" : now.getTime() - last.at.getTime() > JOB_MAX_AGE_MS[name] ? "late" : "ok";
    jobs[name] = { state, lastRunAt: last?.at.toISOString() ?? null, lastResult: last?.result ?? null };
  }
  return { ok: Object.values(jobs).every((j) => j.state === "ok"), checkedAt: now.toISOString(), jobs };
}
