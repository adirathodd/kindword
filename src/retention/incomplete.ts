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
  // failed: businesses (or locations) that could not be purged; deleted: businesses (or customers) that were.
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

// One line per failed item: its ID and the error's class name only, since a database or driver message can quote
// row values.
export function logPurgeFailure(kind: "business" | "location", id: string, e: unknown) {
  console.error(`retention: ${kind} failed id=${id} error=${e instanceof Error ? e.name : "unknown"}`);
}
