// Thrown by a retention purge after it has tried every business or location it found due, when some of them could
// not be deleted (audit O-59-1). The ones that could be deleted are deleted and audited before this is thrown, so
// one stuck business or location never keeps the others past their retention deadline.
//
// Thrown rather than returned so the purge job reports the step as failed (the job log and job_runs.last_result)
// and the queue retries it (src/jobs/jobs.ts); every purge is idempotent, so a retry only re-tries what is still due.
// The message holds counts only: never names, phone numbers, emails or provider text. Item IDs are logged one per
// failure by the purge itself.
export class RetentionPurgeIncompleteError extends Error {
  override name = "RetentionPurgeIncompleteError";
  // failed: businesses (or locations) that could not be purged, including any not tried after MAX_CONSECUTIVE_FAILURES;
  // deleted: businesses (or customers) that were.
  constructor(
    readonly purge: "businesses" | "customers",
    readonly deleted: number,
    readonly failed: number,
  ) {
    super(
      purge === "businesses"
        ? `retention purge incomplete: ${failed} businesses failed, ${deleted} deleted`
        : `retention purge incomplete: ${failed} locations failed, ${deleted} customers deleted`,
    );
  }
}

// Stop a purge after this many failures in a row: the database itself is then likely unwell. drizzle's transaction()
// does not release its pool client when BEGIN fails, so carrying on through every due item could exhaust the pool
// (10 clients) and hang the job instead of failing it. A success resets the count, so a few businesses that always
// fail never block the others for good.
export const MAX_CONSECUTIVE_FAILURES = 5;

// One line per failed item: its ID and either the Postgres error code (SQLSTATE, for example 55P03 lock timeout) or
// the error's class name. Never the message: a database or driver message can quote row values.
export function logPurgeFailure(kind: "business" | "location", id: string, e: unknown) {
  console.error(`retention: ${kind} failed id=${id} error=${errorCode(e)}`);
}

function errorCode(e: unknown): string {
  // drizzle wraps query errors (DrizzleQueryError, name "Error") with the pg error as cause.
  for (let x: unknown = e, i = 0; x instanceof Error && i < 3; x = x.cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return e instanceof Error ? e.name : "unknown";
}
