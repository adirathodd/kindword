// Scheduled background jobs (SPEC Architecture "Jobs", Reliability). Vercel Schedules (vercel.json) calls
// POST /api/jobs/<name>; each job builds its outside services from the environment and runs the existing job code.
//
// Idempotency comes from the job code itself, so overlapping or repeated runs are safe without an extra lock:
// - review-requests: each message row is claimed (FOR UPDATE SKIP LOCKED, marked sent) and committed before the
//   provider is called (src/requests/requests.ts); emails also carry a provider idempotency key.
// - sheet-intake: dedup by the sheet's row ID in visits (src/intake/pollSheet.ts).
// - reviews: unique google_review_id (poll), at most one draft per review (draft), per-location advisory lock plus
//   audit check plus idempotency key (low-rating email).
// - owner-digest: per-location advisory lock, one audit row per local day, idempotency key.
// - purge: deletes under row locks; a rerun finds nothing left.
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
import { sendDailyDigests, sendLowRatingAlerts } from "../notifications/ownerEmails";
import { runReviewRequestJobs, sendConfigFromEnv } from "../requests/requests";
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
export type JobResult = { ok: boolean; steps: Record<string, StepResult | { error: string }> };
async function steps(list: Record<string, () => Promise<StepResult>>): Promise<JobResult> {
  const out: JobResult = { ok: true, steps: {} };
  for (const [name, run] of Object.entries(list)) {
    try {
      out.steps[name] = await run();
    } catch (e) {
      out.ok = false;
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

  // FR-22: daily, with a one-day margin inside the 30-day limit.
  purge: () =>
    steps({
      purge: async () => {
        const r = await purgeExpiredReviews();
        return { reviews: r.reviews, drafts: r.drafts };
      },
    }),
};
