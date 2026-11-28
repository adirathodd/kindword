// Customer data retention (SPEC Security and privacy, "Retention: delete customer rows 12 months after the last
// visit"). Deletes every customer whose most recent visit is more than 12 months old. The database cascades the
// delete to the customer's visits and review requests, so their name, phone, email and consent fields go with them.
//
// What is kept, on purpose:
// - suppression_list: an opt-out is keyed by address, not by customer, and must keep blocking every future import
//   and send (FR-8). Deleting a customer never lifts an opt-out.
// - consent_attestations: the owner's signed list description belongs to the business, not to one customer.
// - sms_opt_ins: consent records from the hosted opt-in page (FR-23); not customer rows. See the PR for the open
//   question on how long consent evidence should be kept.
// - audit_log: IDs and actions only (FR-19). Each deleted customer gets one row with its ID and the location.
//
// Concurrency: each batch takes the same per-location advisory lock the importer takes (src/intake/importCsv.ts), so
// an import cannot add a visit to a customer while it is being deleted, and the "no recent visit" check is re-run
// after the lock is held. Idempotent: a rerun finds nothing left to delete.
//
// The importer refuses rows whose visit is already past this window (visit_past_retention), so a row left in a
// shared Sheet is not imported again after its customer is deleted.
//
// A location whose delete fails is logged by ID and skipped; the other locations are still purged, then
// RetentionPurgeIncompleteError is thrown so the job reports the failure and is retried (audit O-59-1).
import { and, eq, gt, inArray, lte, notExists, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, customers, visits } from "../db/schema";
import { logPurgeFailure, RetentionPurgeIncompleteError } from "./incomplete";

export const CUSTOMER_RETENTION_MONTHS = 12;
const BATCH = 500;
const ACTOR = "system:retention";

// The oldest visit time still kept: `now` minus 12 calendar months, in UTC. A visit at or before this is past the
// retention window. Feb 29 maps to Mar 1 of the previous year, as Date arithmetic does.
export function customerRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - CUSTOMER_RETENTION_MONTHS);
  return cutoff;
}

export type CustomerPurgeResult = { customers: number; cutoff: Date };

export async function purgeExpiredCustomers(
  opts: { now?: Date } = {},
  db: Db = defaultDb,
): Promise<CustomerPurgeResult> {
  const cutoff = customerRetentionCutoff(opts.now ?? new Date());
  // No visit after the cutoff. A customer with no visit at all is left alone: the importer always writes a visit
  // with a new customer, so such a row cannot be dated here; none is expected.
  const noRecentVisit = notExists(
    db
      .select({ one: sql`1` })
      .from(visits)
      .where(and(eq(visits.customerId, customers.id), gt(visits.visitAt, cutoff))),
  );
  const hasOldVisit = sql`exists (select 1 from ${visits} where ${visits.customerId} = ${customers.id} and ${lte(visits.visitAt, cutoff)})`;

  let total = 0;
  // Done one location at a time, so each batch holds one import lock.
  const locationRows = await db
    .selectDistinct({ locationId: customers.locationId })
    .from(customers)
    .where(and(hasOldVisit, noRecentVisit));
  // One location's failure (a lock timeout, a database error) rolls back only its current batch and skips the rest of
  // that location; the other locations are still purged in this run (audit O-59-1). Batches already committed for the
  // failed location stay deleted. The job then reports the failure and is retried (RetentionPurgeIncompleteError).
  let failed = 0;
  for (const { locationId } of locationRows) {
    try {
      for (;;) {
        const n = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${locationId}))`); // the importer's lock
          const expired = await tx
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.locationId, locationId), hasOldVisit, noRecentVisit))
            .orderBy(customers.id)
            .limit(BATCH)
            .for("update");
          if (!expired.length) return { deleted: 0, full: false };
          const deleted = await tx
            .delete(customers)
            .where(
              and(
                inArray(
                  customers.id,
                  expired.map((c) => c.id),
                ),
                noRecentVisit, // re-checked in a new statement, after the lock: sees any visit committed meanwhile
              ),
            )
            .returning({ id: customers.id });
          if (deleted.length)
            await tx.insert(auditLog).values(
              deleted.map((c) => ({
                locationId,
                entity: "customer",
                entityId: c.id,
                action: "purged",
                actor: ACTOR,
                detail: `reason=retention_${CUSTOMER_RETENTION_MONTHS}m`,
              })),
            );
          return { deleted: deleted.length, full: expired.length === BATCH };
        });
        total += n.deleted;
        if (!n.full) break;
      }
    } catch (e) {
      failed++;
      logPurgeFailure("location", locationId, e);
    }
  }
  if (failed) throw new RetentionPurgeIncompleteError("customers", total, failed);
  return { customers: total, cutoff };
}
