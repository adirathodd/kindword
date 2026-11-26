// CSV intake (SPEC FR-2, FR-3). Results and errors carry row numbers and reason codes only, never contact data.
import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import { db as defaultDb, type Db } from "../db/client";
import { consentAttestations, consentMethod, customers, locations, visits } from "../db/schema";
import { customerRetentionCutoff } from "../retention/customers";
import { normalizePhone, parseTime } from "./normalize";

export const COLUMNS = [
  "name",
  "phone",
  "email",
  "visit_time",
  "consent_method",
  "consent_date",
  "evidence_ref",
] as const;

const UploadContext = z.object({
  attestationId: z.uuid(), // operator picks the list's attestation per upload
  consentWordingVersion: z.string().trim().min(1),
});
export type UploadContext = z.input<typeof UploadContext>;

export type RowResult =
  | { row: number; status: "inserted"; reason: "ok" | "existing_customer" | "phone_dropped_no_consent" }
  | { row: number; status: "skipped"; reason: "duplicate_in_file" | "duplicate_visit" }
  | {
      row: number;
      status: "rejected";
      reason:
        | "attestation_invalid"
        | "missing_row_id"
        | "invalid_phone"
        | "invalid_email"
        | "invalid_visit_time"
        | "visit_past_retention"
        | "no_contact"
        | "no_consent_no_email"
        | "contact_conflict";
    };

export type ImportResult =
  | { ok: true; rows: RowResult[] }
  | { ok: false; error: "malformed_csv"; row: number }
  | { ok: false; error: "missing_columns"; columns: string[] };

type Reason = RowResult["reason"];
type Location = typeof locations.$inferSelect;
// One parsed row. `row` is the number shown to the operator; `rowId` is the Sheet's row ID (sheet source only).
export type IntakeRow = { row: number; raw: Record<string, string>; rowId?: string };

const text = z.string().transform((v) => v.trim() || undefined);
const toMethod = (v?: string) => {
  const m = v?.toLowerCase().replace(/[\s_-]+/g, "_");
  return consentMethod.enumValues.find((e) => e === m);
};

const rowSchema = (tz: string) =>
  z.object({
    name: text,
    phone: text.refine((v) => !v || normalizePhone(v) !== null, "invalid_phone"),
    email: text.refine((v) => !v || z.email().safeParse(v).success, "invalid_email"),
    visit_time: text.refine((v) => !!v && parseTime(v, tz) !== null, "invalid_visit_time"),
    consent_method: text.transform(toMethod),
    consent_date: text.transform((v) => (v ? parseTime(v, tz) : null)),
    evidence_ref: text,
  });

// Header is row 1. shortcut: blank lines are not counted and a quoted multi-line field counts once, so numbers drift
// from the spreadsheet view in those files; track line offsets if operators get confused.
const rowNo = (i: number) => i + 2;

export async function importCsv(
  locationId: string,
  csvText: string,
  uploadContext: UploadContext,
  db: Db = defaultDb,
): Promise<ImportResult> {
  const ctx = UploadContext.parse(uploadContext);
  z.uuid().parse(locationId); // a non-UUID would otherwise surface as a raw Postgres error
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  if (!loc) throw new Error("importCsv: location not found");

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (parsed.errors.length) return { ok: false, error: "malformed_csv", row: rowNo(parsed.errors[0].row ?? -1) };
  // papaparse renames a repeated header to "phone_1" and keeps going; which column is right is ambiguous.
  if (Object.keys(parsed.meta.renamedHeaders ?? {}).length) return { ok: false, error: "malformed_csv", row: 1 };
  const missing = COLUMNS.filter((c) => !parsed.meta.fields?.includes(c));
  if (missing.length) return { ok: false, error: "missing_columns", columns: missing };

  const rows = parsed.data.map((raw, i) => ({ row: rowNo(i), raw }));
  return { ok: true, rows: await importRows(loc, rows, ctx, "csv", db) };
}

// FR-2's row rules, shared by the CSV and Sheet paths so both apply exactly the same checks.
export async function importRows(
  loc: Location,
  input: IntakeRow[],
  uploadContext: UploadContext,
  source: "csv" | "sheet",
  db: Db = defaultDb,
): Promise<RowResult[]> {
  const ctx = UploadContext.parse(uploadContext);
  const locationId = loc.id;

  // The FK also enforces this; checking first rejects the whole upload instead of importing half of it.
  const [att] = await db
    .select({ id: consentAttestations.id })
    .from(consentAttestations)
    .where(and(eq(consentAttestations.id, ctx.attestationId), eq(consentAttestations.businessId, loc.businessId)));
  if (!att) return input.map(({ row }) => ({ row, status: "rejected", reason: "attestation_invalid" }));

  // Sheet rows already imported are skipped before they can claim contacts for in-read dedup; otherwise a repeat
  // customer's newer row would be skipped as duplicate_in_file on every poll, forever.
  const imported = new Set(
    source === "sheet"
      ? (
          await db
            .select({ id: visits.externalVisitId })
            .from(visits)
            .where(and(eq(visits.locationId, locationId), eq(visits.source, "sheet")))
        ).map((v) => v.id)
      : [],
  );

  const schema = rowSchema(loc.timezone);
  const seen = new Set<string>(); // normalized phones and emails (and sheet row IDs) already accepted from this read
  const rows: RowResult[] = [];
  const now = new Date();
  const retentionCutoff = customerRetentionCutoff(now);

  for (const { row, raw, rowId } of input) {
    const res = (status: RowResult["status"], reason: Reason) => rows.push({ row, status, reason } as RowResult);

    if (source === "sheet") {
      if (!rowId) {
        res("rejected", "missing_row_id");
        continue;
      }
      // Already imported: later edits to the row are ignored, as an import never modifies an existing customer.
      if (imported.has(rowId) || seen.has(`row:${rowId}`)) {
        res("skipped", imported.has(rowId) ? "duplicate_visit" : "duplicate_in_file");
        continue;
      }
    }

    const r = schema.safeParse(raw);
    if (!r.success) {
      res("rejected", r.error.issues[0].message as Reason);
      continue;
    }
    const v = r.data;
    // SPEC Security, Retention: customer rows are deleted 12 months after the last visit (src/retention/customers.ts),
    // so a visit already that old is never stored. Also stops a row left in a shared Sheet from coming back after its
    // customer was deleted. Such a request would be skipped as stale anyway (FR-5).
    if (parseTime(v.visit_time!, loc.timezone)! <= retentionCutoff) {
      res("rejected", "visit_past_retention");
      continue;
    }
    const phone = v.phone ? normalizePhone(v.phone)! : undefined;
    const email = v.email?.toLowerCase();
    if (!phone && !email) {
      res("rejected", "no_contact");
      continue;
    }
    const consented = !!(v.consent_method && v.consent_date && v.consent_date <= now && v.evidence_ref);
    if (phone && !consented && !email) {
      res("rejected", "no_consent_no_email");
      continue;
    }
    // Dedup on the row's phone even when it will be dropped, so one person is not split across rows.
    if ((phone && seen.has(phone)) || (email && seen.has(email))) {
      res("skipped", "duplicate_in_file");
      continue;
    }
    const keptPhone = phone && consented ? phone : undefined;
    const visitAt = parseTime(v.visit_time!, loc.timezone)!;

    let outcome: [RowResult["status"], Reason];
    try {
      // One transaction per row: a bad row never rolls back good ones.
      outcome = await db.transaction(async (tx) => {
        // Serialize imports per location so concurrent uploads cannot race the customer lookup.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${locationId}))`);
        // Match on the row's phone even when it will be dropped (used, never stored), so a person already on file
        // is not split into a second email-only customer and asked twice (FR-9).
        const matches = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.locationId, locationId),
              or(
                phone ? eq(customers.normalizedPhone, phone) : undefined,
                email ? eq(customers.normalizedEmail, email) : undefined,
              ),
            ),
          );
        const existing = matches[0];
        if (
          matches.length > 1 ||
          (existing && phone && existing.normalizedPhone && existing.normalizedPhone !== phone) ||
          (existing && email && existing.normalizedEmail && existing.normalizedEmail !== email)
        )
          return ["rejected", "contact_conflict"];

        // Existing customers are never modified by an import.
        const customerId =
          existing?.id ??
          (
            await tx
              .insert(customers)
              .values({
                locationId,
                businessId: loc.businessId,
                name: v.name,
                phone: keptPhone ? v.phone : null,
                normalizedPhone: keptPhone ?? null,
                email: email ? v.email : null,
                normalizedEmail: email ?? null,
                ...(keptPhone && {
                  consentMethod: v.consent_method,
                  consentWordingVersion: ctx.consentWordingVersion,
                  consentAt: v.consent_date,
                  consentEvidenceRef: v.evidence_ref,
                  attestationId: ctx.attestationId,
                }),
              })
              .returning({ id: customers.id })
          )[0].id;

        // The same job already on file from either source (e.g. in a CSV and in the Sheet) is asked about once.
        const sameJob = await tx
          .select({ id: visits.id })
          .from(visits)
          .where(and(eq(visits.customerId, customerId), eq(visits.visitAt, visitAt)));
        if (sameJob.length) return ["skipped", "duplicate_visit"];

        const externalVisitId =
          source === "sheet"
            ? rowId!
            : createHash("sha256").update(`${customerId}|${visitAt.toISOString()}`).digest("hex");
        const inserted = await tx
          .insert(visits)
          .values({ customerId, locationId, visitAt, source, externalVisitId })
          .onConflictDoNothing()
          .returning({ id: visits.id });
        if (!inserted.length) return ["skipped", "duplicate_visit"];
        if (phone && !keptPhone) return ["inserted", "phone_dropped_no_consent"];
        return ["inserted", existing ? "existing_customer" : "ok"];
      });
    } catch (e) {
      // pg error details can echo column values; surface only the code and constraint.
      const err = e as { cause?: { code?: string; constraint?: string }; code?: string; constraint?: string };
      const pg = err.cause ?? err;
      throw new Error(
        `${source === "csv" ? "importCsv" : "pollSheet"}: row ${row} failed (${pg.code ?? "unknown"} ${pg.constraint ?? ""})`.trim(),
      );
    }
    res(...outcome);
    // Only rows that were accepted claim their contacts; a rejected row must not block a later valid one. A sheet is
    // re-read every poll, so there a skipped row must not claim either, or it would block the next row forever.
    if (outcome[0] === "inserted" || (outcome[0] === "skipped" && source === "csv")) {
      if (phone) seen.add(phone);
      if (email) seen.add(email);
      if (rowId) seen.add(`row:${rowId}`);
    }
  }
  return rows;
}
