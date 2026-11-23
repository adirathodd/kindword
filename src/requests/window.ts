// Allowed sending hours (SPEC FR-5, Compliance): 9 a.m. to 8 p.m. in the location's time zone. Times are stored in
// UTC and converted here, so daylight saving is handled by the zone database.
import { parseTime } from "../intake/normalize";

export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 20; // exclusive: 8:00 p.m. is outside the window

function localParts(t: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour };
}

export function inSendWindow(t: Date, timeZone: string): boolean {
  const { hour } = localParts(t, timeZone);
  return hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

// The earliest instant at or after t that is inside the window: t itself, or the next 9:00 a.m. local.
export function nextSendTime(t: Date, timeZone: string): Date {
  const { y, m, d, hour } = localParts(t, timeZone);
  if (hour >= OPEN_HOUR && hour < CLOSE_HOUR) return t;
  // Before 9 a.m. it is today's 9 a.m.; from 8 p.m. on it is tomorrow's. Date.UTC rolls month and year ends over.
  const day = new Date(Date.UTC(y, m - 1, hour < OPEN_HOUR ? d : d + 1));
  const iso = day.toISOString().slice(0, 10);
  return parseTime(`${iso}T${String(OPEN_HOUR).padStart(2, "0")}:00`, timeZone)!; // 9 a.m. is never in a DST gap
}
