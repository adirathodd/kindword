// Failure records for sends that operator alerts did not see before (SPEC Reliability: "Alerts go to the operator
// when a send fails"): owner emails (daily digest, low-rating email, monthly report) and the one opt-out
// confirmation text. Review-request failures already have their own record (src/requests/requests.ts).
//
// Each failed attempt writes one audit row with IDs and a short error code only: never an address, a phone number,
// message text or a provider's message (SPEC hard constraints, FR-19). Writing the row is best effort: a failure here
// is swallowed so it can never change what the send path does (owner emails are still retried on the next run; the
// inbound webhook still answers 500).
import { db as defaultDb, type Db } from "../db/client";
import { auditLog } from "../db/schema";
import { ResendSendError } from "../email/resend";
import { TwilioSendError } from "../sms/twilio";

export const FAILURE_ACTIONS = {
  owner_email: "owner_email_failed",
  opt_out_confirmation: "opt_out_confirmation_failed",
} as const;
export type OwnerEmailKind = "digest" | "low_rating" | "monthly_report";
const ACTOR = "system:send_failure";

// A short, safe code for an error: the provider's status and error code, "bad_time_zone", or the error's class name.
export function failureCode(e: unknown): string {
  if (e instanceof ResendSendError) return `email_${e.code ?? `status_${e.status}`}`;
  if (e instanceof TwilioSendError) return `sms_${e.code ?? `status_${e.status}`}`;
  if (e instanceof RangeError) return "bad_time_zone"; // Intl refuses the location's time zone
  return e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "unknown";
}

// period: the day (YYYY-MM-DD) or month (YYYY-MM) the email is for. Operator alerts report each location, kind and
// period once, however many runs retry it.
export async function recordOwnerEmailFailure(
  f: { locationId: string; kind: OwnerEmailKind; period: string; error: unknown; at?: Date },
  db: Db = defaultDb,
) {
  try {
    await db.insert(auditLog).values({
      locationId: f.locationId,
      entity: "location",
      entityId: f.locationId,
      action: FAILURE_ACTIONS.owner_email,
      actor: ACTOR,
      detail: `kind=${f.kind};period=${f.period};error=${failureCode(f.error)}`,
      ...(f.at ? { at: f.at } : {}),
    });
  } catch {
    // best effort, see above
  }
}

// locationId: the location whose number the customer texted, or null when no location uses that number.
export async function recordOptOutConfirmationFailure(locationId: string | null, error: unknown, db: Db = defaultDb) {
  try {
    await db.insert(auditLog).values({
      locationId,
      entity: "location",
      entityId: locationId,
      action: FAILURE_ACTIONS.opt_out_confirmation,
      actor: ACTOR,
      detail: `error=${failureCode(error)}`,
    });
  } catch {
    // best effort, see above
  }
}

// The UTC day or month, for a failure that happened before the location's own date could be worked out.
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const utcMonth = (d: Date) => d.toISOString().slice(0, 7);
