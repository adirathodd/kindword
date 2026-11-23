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

const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

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
export function parseTime(raw: string, timeZone: string): Date | null {
  const v = raw.trim();
  if (OFFSET_ISO.test(v)) {
    const d = new Date(v);
    return Number.isNaN(+d) ? null : d;
  }
  const m = NAIVE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const w = new Date(wall);
  if (w.getUTCFullYear() !== y || w.getUTCMonth() !== mo - 1 || w.getUTCDate() !== d ||
      w.getUTCHours() !== h || w.getUTCMinutes() !== mi || w.getUTCSeconds() !== s) return null; // e.g. Feb 30, 25:00
  const first = wall - tzOffset(wall, timeZone);
  return new Date(wall - tzOffset(first, timeZone)); // second pass corrects guesses that straddle a DST change
}
