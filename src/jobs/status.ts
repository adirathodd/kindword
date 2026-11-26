// Outside check that the scheduled jobs run at all (SPEC Stack, Monitoring: "a daily check that jobs ran").
//
// Operator alerts (src/notifications/operatorAlerts.ts) run on Vercel Schedules too, so a full Schedules or Queues
// outage, or a consumer that never starts, would stop the alerts along with everything else. This module records
// one audit row each time a scheduled job finishes a run, and GET /api/status/jobs reports whether every job has run
// recently enough. An uptime monitor outside Vercel polls that route and alerts the operator when it answers 503.
//
// "Ran" means the job was delivered and finished a run, whatever its result: a job that runs but fails is already
// visible in the job logs and, for sends and Google access, in operator alerts. This check is about the scheduler.
//
// What is stored and shown: job names, the time of each run and "ok" or "failed". Never personal data, message
// text, review text, setting values or error messages.
import { and, eq, gt, inArray, isNull, lte, max } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog } from "../db/schema";

const ENTITY = "job";
const ACTOR = "system:jobs";
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
// Runs older than this are not read: every limit above is shorter, so they cannot change the answer.
const LOOKBACK_MS = 7 * 24 * HOUR;

// Records that a job finished a run. Called by the scheduled-job handler after every run, including retries.
export async function recordJobRun(name: string, ok: boolean, db: Db = defaultDb, now: Date = new Date()) {
  await db.insert(auditLog).values({
    locationId: null,
    entity: ENTITY,
    entityId: null,
    action: ok ? JOB_RUN_ACTIONS.ok : JOB_RUN_ACTIONS.failed,
    actor: ACTOR,
    detail: `job=${name}`,
    at: now,
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
  const rows = await db
    .select({ detail: auditLog.detail, action: auditLog.action, at: max(auditLog.at) })
    .from(auditLog)
    .where(
      and(
        isNull(auditLog.locationId), // the (location_id, at) index
        gt(auditLog.at, new Date(now.getTime() - LOOKBACK_MS)),
        lte(auditLog.at, now), // a clock ahead of this one must not hide a stopped job
        eq(auditLog.entity, ENTITY),
        inArray(auditLog.action, Object.values(JOB_RUN_ACTIONS)),
        inArray(
          auditLog.detail,
          names.map((n) => `job=${n}`),
        ),
      ),
    )
    .groupBy(auditLog.detail, auditLog.action);

  const latest = new Map<string, { at: Date; result: "ok" | "failed" }>();
  for (const r of rows) {
    if (!r.detail || !r.at) continue;
    const name = r.detail.slice("job=".length);
    const result = r.action === JOB_RUN_ACTIONS.ok ? "ok" : "failed";
    const seen = latest.get(name);
    if (!seen || r.at > seen.at) latest.set(name, { at: r.at, result });
  }

  const jobs: JobsStatus["jobs"] = {};
  for (const name of names) {
    const last = latest.get(name);
    const state: JobState = !last ? "never" : now.getTime() - last.at.getTime() > JOB_MAX_AGE_MS[name] ? "late" : "ok";
    jobs[name] = { state, lastRunAt: last?.at.toISOString() ?? null, lastResult: last?.result ?? null };
  }
  return { ok: Object.values(jobs).every((j) => j.state === "ok"), checkedAt: now.toISOString(), jobs };
}
