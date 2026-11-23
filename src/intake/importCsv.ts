// CSV intake (SPEC FR-2, FR-3). Results and errors carry row numbers and reason codes only, never contact data.
import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import { db as defaultDb, type Db } from "../db/client";
import { consentAttestations, consentMethod, customers, locations, visits } from "../db/schema";
import { normalizePhone, parseTime } from "./normalize";

export const COLUMNS = ["name", "phone", "email", "visit_time", "consent_method", "consent_date", "evidence_ref"] as const;

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
        | "invalid_phone"
        | "invalid_email"
        | "invalid_visit_time"
        | "no_contact"
        | "no_consent_no_email"
        | "contact_conflict";
    };

export type ImportResult =
  | { ok: true; rows: RowResult[] }
  | { ok: false; error: "malformed_csv"; row: number }
  | { ok: false; error: "missing_columns"; columns: string[] };

type Reason = RowResult["reason"];

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

// Spreadsheet row number: header is row 1.
const rowNo = (i: number) => i + 2;

export async function importCsv(
  locationId: string,
  csvText: string,
  uploadContext: UploadContext,
  db: Db = defaultDb,
): Promise<ImportResult> {
  const ctx = UploadContext.parse(uploadContext);
  const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
  if (!loc) throw new Error("importCsv: location not found");

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (parsed.errors.length) return { ok: false, error: "malformed_csv", row: rowNo(parsed.errors[0].row ?? -1) };
  const missing = COLUMNS.filter((c) => !parsed.meta.fields?.includes(c));
  if (missing.length) return { ok: false, error: "missing_columns", columns: missing };

  // The FK also enforces this; checking first rejects the whole upload instead of importing half of it.
  const [att] = await db
    .select({ id: consentAttestations.id })
    .from(consentAttestations)
    .where(and(eq(consentAttestations.id, ctx.attestationId), eq(consentAttestations.businessId, loc.businessId)));
  if (!att) return { ok: true, rows: parsed.data.map((_, i) => ({ row: rowNo(i), status: "rejected", reason: "attestation_invalid" })) };

  const schema = rowSchema(loc.timezone);
  const seen = new Set<string>(); // normalized phones and emails already accepted from this file
  const rows: RowResult[] = [];
  const now = new Date();

  for (const [i, raw] of parsed.data.entries()) {
    const row = rowNo(i);
    const res = (status: RowResult["status"], reason: Reason) => rows.push({ row, status, reason } as RowResult);

    const r = schema.safeParse(raw);
    if (!r.success) {
      res("rejected", r.error.issues[0].message as Reason);
      continue;
    }
    const v = r.data;
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
    if (phone) seen.add(phone);
    if (email) seen.add(email);

    const keptPhone = phone && consented ? phone : undefined;
    const visitAt = parseTime(v.visit_time!, loc.timezone)!;

    let outcome: [RowResult["status"], Reason];
    try {
      // One transaction per row: a bad row never rolls back good ones.
      outcome = await db.transaction(async (tx) => {
        // Serialize imports per location so concurrent uploads cannot race the customer lookup.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${locationId}))`);
        const matches = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.locationId, locationId),
              or(
                keptPhone ? eq(customers.normalizedPhone, keptPhone) : undefined,
                email ? eq(customers.normalizedEmail, email) : undefined,
              ),
            ),
          );
        const existing = matches[0];
        if (
          matches.length > 1 ||
          (existing && keptPhone && existing.normalizedPhone && existing.normalizedPhone !== keptPhone) ||
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

        const externalVisitId = createHash("sha256").update(`${customerId}|${visitAt.toISOString()}`).digest("hex");
        const inserted = await tx
          .insert(visits)
          .values({ customerId, locationId, visitAt, source: "csv", externalVisitId })
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
      throw new Error(`importCsv: row ${row} failed (${pg.code ?? "unknown"} ${pg.constraint ?? ""})`.trim());
    }
    res(...outcome);
  }
  return { ok: true, rows };
}
