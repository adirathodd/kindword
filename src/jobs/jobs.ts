// Scheduled background jobs (SPEC Architecture "Jobs", Reliability). Each Vercel Schedule (vercel.json `schedules`)
// publishes a message to the `jobs` queue topic; the private consumer (src/app/api/jobs/route.ts) runs the job the
// message names. Each job builds its outside services from the environment and runs the existing job code.
// A run that fails for a reason a retry can fix is retried with backoff (retryPolicy); a missing setting is not.
//
// Idempotency comes from the job code itself, so overlapping or repeated runs are safe without an extra lock:
// - review-requests: each message row is claimed (FOR UPDATE SKIP LOCKED, marked sent) and committed before the
//   provider is called (src/requests/requests.ts); emails also carry a provider idempotency key.
// - sheet-intake: dedup by the sheet's row ID in visits (src/intake/pollSheet.ts).
// - reviews: unique google_review_id (poll), at most one draft per review (draft), per-location advisory lock plus
//   audit check plus idempotency key (low-rating email).
// - owner-digest: per-location advisory lock, one audit row per local day, idempotency key.
// - purge: deletes under row locks; a rerun finds nothing left.
// - operator-alerts: one advisory lock, one audit row per alerted problem, idempotency key.
// - optout-confirmations: each attempt is claimed by a guarded update; an unknown outcome is checked with Twilio
//   before any resend; nothing is sent after 5 minutes (src/optout/confirmations.ts).
//
// Results are counts and short codes only: never phone numbers, emails, message text, review text or names.
import { isNotNull, and } from "drizzle-orm";
import { draftModelFromEnv } from "../ai/config";
import { db } from "../db/client";
import { sheetSources } from "../db/schema";
import { ResendEmail, resendConfigFromEnv } from "../email/resend";
import { BusinessProfileClient, googleOAuthConfigFromEnv } from "../google/businessProfile";
import { inboxBaseUrl } from "../inbox/auth";
import { GoogleSheetsError, GoogleSheetsReader, googleSheetsConfigFromEnv } from "../intake/googleSheets";
import { pollSheet } from "../intake/pollSheet";
import { sendMonthlyReports } from "../reports/monthly";
import { sendOperatorAlerts } from "../notifications/operatorAlerts";
import { sendDailyDigests, sendLowRatingAlerts } from "../notifications/ownerEmails";
import { runReviewRequestJobs, sendConfigFromEnv } from "../requests/requests";
import { sendPendingConfirmations } from "../optout/confirmations";
import { purgeExpiredCustomers } from "../retention/customers";
import { draftPendingReviews } from "../reviews/draft";
import { pollReviews } from "../reviews/poll";
import { purgeExpiredReviews } from "../reviews/purge";
import { TwilioSms, twilioConfigFromEnv } from "../sms/twilio";

// A missing or malformed setting. Its message names the setting, never its value, so it is safe to log.
export class JobConfigError extends Error {}
function configure<T>(build: () => T): T {
  try {
    return build();
  } catch (e) {
    throw new JobConfigError(e instanceof Error ? e.message : "configuration error");
  }
}

// Every step runs even if an earlier one fails, so one missing service does not stop the others.
type StepResult = Record<string, unknown>;
// retryable: some step failed for a reason other than a missing setting (a timeout, a database error).
export type JobResult = { ok: boolean; retryable: boolean; steps: Record<string, StepResult | { error: string }> };
async function steps(list: Record<string, () => Promise<StepResult>>): Promise<JobResult> {
  const out: JobResult = { ok: true, retryable: false, steps: {} };
  for (const [name, run] of Object.entries(list)) {
    try {
      out.steps[name] = await run();
    } catch (e) {
      out.ok = false;
      if (!(e instanceof JobConfigError)) out.retryable = true;
      // Other errors may echo provider responses, so only their class name is kept.
      out.steps[name] = { error: e instanceof JobConfigError ? e.message : e instanceof Error ? e.name : "unknown" };
    }
  }
  return out;
}

const email = () => new ResendEmail(configure(() => resendConfigFromEnv()));
const count = <T extends string>(xs: T[]) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

export const JOBS: Record<string, () => Promise<JobResult>> = {
  // FR-2a: every 15 minutes. Sheets the operator has not finished configuring report not_configured.
  "sheet-intake": () =>
    steps({
      poll: async () => {
        const reader = new GoogleSheetsReader(configure(() => googleSheetsConfigFromEnv()));
        const sources = await db
          .select({ id: sheetSources.id })
          .from(sheetSources)
          .where(and(isNotNull(sheetSources.attestationId), isNotNull(sheetSources.consentWordingVersion)));
        const outcomes: string[] = [];
        const rows: string[] = [];
        for (const { id } of sources) {
          try {
            const r = await pollSheet(id, reader);
            outcomes.push(r.ok ? "ok" : r.error);
            if (r.ok) rows.push(...r.rows.map((x) => x.status));
          } catch (e) {
            outcomes.push(e instanceof GoogleSheetsError ? e.code : "error"); // one sheet's failure skips only that sheet
          }
        }
        return { sheets: count(outcomes), rows: count(rows) };
      },
    }),

  // FR-5, FR-6: schedule requests and the one reminder, then send what is due inside the 9 a.m. to 8 p.m. window.
  "review-requests": () =>
    steps({
      run: async () => {
        const config = configure(() => sendConfigFromEnv());
        const sms = new TwilioSms(configure(() => twilioConfigFromEnv()));
        const r = await runReviewRequestJobs({ sms, email: email() }, { config });
        return { scheduled: r.scheduled.scheduled, reminders: r.reminders.scheduled, ...r.sent };
      },
    }),

  // FR-11, then FR-12 drafts for what polling found, then the FR-13 low-rating email. Every run reads every
  // review, so a missed run is caught up by the next one.
  reviews: () =>
    steps({
      poll: async () => {
        const source = new BusinessProfileClient(configure(() => googleOAuthConfigFromEnv()));
        const tokenSecret = configure(() => {
          const s = process.env.GOOGLE_TOKEN_SECRET;
          if (!s || s.length < 32) throw new Error("GOOGLE_TOKEN_SECRET missing or shorter than 32 chars");
          return s;
        });
        const r = await pollReviews({ source, tokenSecret });
        return { locations: r.locations, newReviews: r.newReviews, failed: count(r.failed.map((f) => f.code)) };
      },
      draft: async () => ({ ...(await draftPendingReviews(configure(() => draftModelFromEnv()))) }),
      lowRating: async () => ({
        ...(await sendLowRatingAlerts({ email: email(), baseUrl: configure(() => inboxBaseUrl()) })),
      }),
    }),

  // FR-13: hourly; each location gets its digest on the first run at or after DIGEST_HOUR local time.
  "owner-digest": () =>
    steps({
      digest: async () => ({
        ...(await sendDailyDigests({ email: email(), baseUrl: configure(() => inboxBaseUrl()) })),
      }),
    }),

  // FR-22: daily, with a one-day margin inside the 30-day limit. Then the SPEC Security retention rule: customers
  // whose last visit is more than 12 months old, deleted under the importer's per-location lock.
  purge: () =>
    steps({
      purge: async () => {
        const r = await purgeExpiredReviews();
        return { reviews: r.reviews, drafts: r.drafts };
      },
      customers: async () => ({ customers: (await purgeExpiredCustomers()).customers }),
    }),

  // FR-17: hourly; each location gets last month's report on the first run at or after DIGEST_HOUR local time on
  // the 1st. Idempotent: per-location advisory lock, one audit row per month (month only), idempotency key.
  "monthly-report": () =>
    steps({
      report: async () => {
        const source = new BusinessProfileClient(configure(() => googleOAuthConfigFromEnv()));
        const tokenSecret = configure(() => {
          const s = process.env.GOOGLE_TOKEN_SECRET;
          if (!s || s.length < 32) throw new Error("GOOGLE_TOKEN_SECRET missing or shorter than 32 chars");
          return s;
        });
        return {
          ...(await sendMonthlyReports({
            email: email(),
            source,
            tokenSecret,
            baseUrl: configure(() => inboxBaseUrl()),
          })),
        };
      },
    }),

  // SPEC Reliability: alert the operator when a send fails, a Google token expires, or the review check has not run
  // in 3 hours. Every 15 minutes, on its own schedule so a stopped or misconfigured reviews job is still noticed.
  "operator-alerts": () =>
    steps({
      alerts: async () => {
        const operatorEmail = configure(() => {
          const v = process.env.OPERATOR_EMAIL?.trim();
          if (!v) throw new Error("OPERATOR_EMAIL missing");
          return v;
        });
        return { ...(await sendOperatorAlerts({ email: email(), operatorEmail })) };
      },
    }),

  // FR-8, Flow 2 step 4 (audit F-9-2): the inbound webhook publishes this job with a 60 s delay when its confirmation
  // send fails; the 15-minute schedule only marks anything left over as expired.
  "optout-confirmations": () =>
    steps({
      send: async () => {
        const r = await sendPendingConfirmations(new TwilioSms(configure(() => twilioConfigFromEnv())));
        if (r.open > 0) throw new ConfirmationsOpenError();
        return { ...r };
      },
    }),
};

// Thrown while an opt-out confirmation is still open inside its 5 minutes, so retryPolicy redelivers in 30 s, then
// 1 and 2 min, and every confirmation is sent or expired within its window.
export class ConfirmationsOpenError extends Error {}

// The message a static schedule publishes (Vercel Schedules, topic target). Only `name` is used: it is the
// schedule's key in vercel.json, which matches a key of JOBS.
export type ScheduleMessage = { name?: unknown; executionId?: unknown; scheduledAt?: unknown };

export class JobFailedError extends Error {} // message: the job name only

// Runs the job a schedule message names. Returning acknowledges the message; throwing hands it to retryPolicy.
// Every job is idempotent, so a redelivery, a retry or a run overlapping the next tick never sends twice.
export async function runScheduled(message: ScheduleMessage): Promise<void> {
  const name = typeof message?.name === "string" ? message.name : "";
  const run = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined;
  if (!run) {
    console.error("job: unknown schedule name"); // a vercel.json schedule with no job here; retrying cannot help
    return;
  }
  const result = await run();
  const line = `job ${name}: ${result.ok ? "ok" : "failed"} ${JSON.stringify(result.steps)}`;
  if (result.ok) return void console.log(line);
  console.error(line);
  // Only missing settings failed: a retry would fail the same way, and the next scheduled run tries again.
  if (result.retryable) throw new JobFailedError(name);
}

// Backoff 30 s, 1, 2, 4, 8 min; after MAX_DELIVERIES the message is dropped and the next scheduled run picks the
// work up (every job reads its whole backlog each run).
export const MAX_DELIVERIES = 6;
export function retryPolicy(error: unknown, metadata: { deliveryCount: number }) {
  const job = error instanceof JobFailedError ? error.message : "unknown";
  if (metadata.deliveryCount >= MAX_DELIVERIES) {
    console.error(`job ${job}: giving up after ${metadata.deliveryCount} deliveries`);
    return { acknowledge: true as const };
  }
  return { afterSeconds: 30 * 2 ** (metadata.deliveryCount - 1) };
}
