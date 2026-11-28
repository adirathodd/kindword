// Google Sheet intake (SPEC FR-2a). Same row rules as CSV via importRows; results carry row numbers and reason
// codes only, never contact data. Meant to run every 15 minutes; no scheduler is chosen yet, so callers invoke it.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "../db/client";
import { locations, sheetSources } from "../db/schema";
import { COLUMNS, importRows, isOffboarded, type ImportResult } from "./importCsv";

// Reads one sheet as our service account (viewer only, no owner OAuth). Header row first, then data rows, each a
// list of cell strings; trailing empty cells may be missing, as in the Sheets API's values.get.
export interface SheetReader {
  readRows(sheetId: string): Promise<string[][]>;
}

export type PollResult =
  | ImportResult
  | { ok: false; error: "not_configured" } // operator has not set the attestation or consent wording version
  | { ok: false; error: "duplicate_columns" };

const SHEET_COLUMNS = [...COLUMNS, "row_id"];

export async function pollSheet(sheetSourceId: string, reader: SheetReader, db: Db = defaultDb): Promise<PollResult> {
  z.uuid().parse(sheetSourceId);
  const [src] = await db.select().from(sheetSources).where(eq(sheetSources.id, sheetSourceId));
  if (!src) throw new Error("pollSheet: sheet source not found");
  if (!src.attestationId || !src.consentWordingVersion) return { ok: false, error: "not_configured" };
  const [loc] = await db.select().from(locations).where(eq(locations.id, src.locationId));
  // FR-20: an offboarded client's Sheet is not read at all (and lastReadAt stays put), not just left unimported.
  if (await isOffboarded(loc.businessId, db)) return { ok: false, error: "business_offboarded" };

  const [header = [], ...body] = await reader.readRows(src.sheetId);
  const fields = header.map((h) => h.trim().toLowerCase());
  const named = fields.filter(Boolean);
  if (new Set(named).size !== named.length) return { ok: false, error: "duplicate_columns" };
  const missing = SHEET_COLUMNS.filter((c) => !fields.includes(c));
  if (missing.length) return { ok: false, error: "missing_columns", columns: missing };

  const idCol = fields.indexOf("row_id");
  const rows = body
    .map((cells, i) => ({
      row: i + 2, // the sheet's own row number (header is row 1)
      raw: Object.fromEntries(fields.map((f, j) => [f, cells[j] ?? ""])),
      rowId: cells[idCol]?.trim() || undefined,
    }))
    .filter((r) => Object.values(r.raw).some((v) => v.trim())); // blank rows

  const results = await importRows(
    loc,
    rows,
    { attestationId: src.attestationId, consentWordingVersion: src.consentWordingVersion },
    "sheet",
    db,
  );
  // Offboarded during the read (FR-20): nothing more was stored, and the source is left as it was, not marked read.
  if (results.some((r) => r.status === "rejected" && r.reason === "business_offboarded"))
    return { ok: true, rows: results };
  // Each row has committed in its own transaction by now. A crash before this line only leaves the marker stale;
  // re-reads stay idempotent because dedup is by row ID in visits, not by last_row_id.
  await db
    .update(sheetSources)
    .set({ lastRowId: rows.findLast((r) => r.rowId)?.rowId ?? src.lastRowId, lastReadAt: new Date() })
    .where(eq(sheetSources.id, src.id));
  return { ok: true, rows: results };
}
