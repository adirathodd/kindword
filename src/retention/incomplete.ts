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
  // failed: businesses (or locations) that could not be purged, including any not tried after an early stop
  // (MAX_CONSECUTIVE_FAILURES);
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

// Stop a purge after this many connection failures in a row: the database itself is then likely unreachable.
// drizzle's transaction() does not release its pool client when BEGIN fails, so carrying on through every due item
// could exhaust the pool (10 clients, shared with the other purge steps) and hang the job instead of failing it.
// Only connection-level failures count (see countsTowardStop): an SQL error inside the transaction is rolled back and
// its client released, so businesses that always fail for their own reason never block the others. A success
// resets the count.
export const MAX_CONSECUTIVE_FAILURES = 3;

// True unless Postgres itself answered with an SQL error (a pg DatabaseError, which has a SQLSTATE and a severity)
// outside the connection classes (08 connection exception, 57P operator intervention such as a shutdown).
export function countsTowardStop(e: unknown): boolean {
  const pg = pgError(e);
  return !pg || pg.code.startsWith("08") || pg.code.startsWith("57P");
}

// One line per failed item: its ID and either the Postgres error code (SQLSTATE, for example 55P03 lock timeout) or
// the error's class name. Never the message: a database or driver message can quote row values.
export function logPurgeFailure(kind: "business" | "location", id: string, e: unknown) {
  console.error(`retention: ${kind} failed id=${id} error=${errorCode(e)}`);
}

function errorCode(e: unknown): string {
  return pgError(e)?.code ?? (e instanceof Error ? e.name : "unknown");
}

// The Postgres error in the cause chain: drizzle wraps query errors (DrizzleQueryError, name "Error") with the pg
// error as cause. Node socket errors (ECONNRESET, EPIPE) have a code but no severity, so they are not matched.
function pgError(e: unknown): { code: string } | undefined {
  for (let x: unknown = e, i = 0; x instanceof Error && i < 3; x = x.cause, i++) {
    const { code, severity } = x as { code?: unknown; severity?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string") return { code };
  }
  return undefined;
}
