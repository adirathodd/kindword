// US-only (NJ/NYC clients). Returns E.164 or null.
// shortcut: checks NANP shape only, not whether the area code is assigned; upgrade to libphonenumber-js if typos reach Twilio often.
export function normalizePhone(raw: string): string | null {
  const v = raw.trim();
  if (/[^\d\s()+.-]/.test(v)) return null; // letters, "ext", etc.
  if (v.includes("+") && !/^\+1\D*\d/.test(v)) return null; // non-US country code
  let d = v.replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `+1${d}` : null;
}

// YYYY-MM-DD, optional [T ]HH:MM[:SS[.mmm]], optional Z or ±HH:MM after a time.
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// ms the zone is ahead of UTC at instant t.
function tzOffset(t: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return local - Math.floor(t / 1000) * 1000;
}

// ISO 8601 with an offset, or a naive date/time read as wall-clock time in timeZone (date only = local midnight).
// shortcut: a wall-clock time skipped by a DST jump (e.g. 2:30 a.m. in March) resolves to an adjacent hour.
// Validates the calendar fields itself: new Date() would roll "2026-02-30" over to March 2 and accept "T24:00".
export function parseTime(raw: string, timeZone: string): Date | null {
  const m = TIME.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0));
  const ms = Number((m[7] ?? "").padEnd(3, "0"));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const w = new Date(wall);
  if (
    w.getUTCFullYear() !== y ||
    w.getUTCMonth() !== mo - 1 ||
    w.getUTCDate() !== d ||
    w.getUTCHours() !== h ||
    w.getUTCMinutes() !== mi ||
    w.getUTCSeconds() !== s
  )
    return null; // e.g. Feb 30, 24:00
  const zone = m[8];
  if (zone === "Z") return w;
  if (zone) {
    const [oh, om] = zone.slice(1).split(":").map(Number);
    if (oh > 14 || om > 59) return null;
    return new Date(wall - (zone[0] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000);
  }
  const first = wall - tzOffset(wall, timeZone);
  return new Date(wall - tzOffset(first, timeZone)); // second pass corrects guesses that straddle a DST change
}
