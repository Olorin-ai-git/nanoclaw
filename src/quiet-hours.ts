import { resolveTimezone } from './timezone.js';

export interface HourMinute {
  hour: number;
  minute: number;
}

export function parseHHMM(value: string): HourMinute {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid HH:MM value: ${value}`);
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`HH:MM out of range: ${value}`);
  }
  return { hour, minute };
}

/**
 * Get the current hour:minute in the given timezone as a total-minutes-of-day integer.
 */
function minutesOfDay(at: Date, timezone: string): number {
  const tz = resolveTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  // Intl may emit "24" for midnight in some locales; normalize.
  const h = hour === 24 ? 0 : hour;
  return h * 60 + minute;
}

/**
 * Quiet hours: returns true when local time is in [start, end).
 * Handles wrap-around (e.g., 23:00 → 07:00).
 */
export function isInQuietHours(
  at: Date,
  startHHMM: string,
  endHHMM: string,
  timezone: string,
): boolean {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  const now = minutesOfDay(at, timezone);
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute;
  if (s === e) return false; // degenerate
  if (s < e) {
    // non-wrapping (e.g. 00:00 → 06:00)
    return now >= s && now < e;
  }
  // wrapping (e.g. 23:00 → 07:00)
  return now >= s || now < e;
}

/** Monday–Friday check in the given timezone. */
export function isWeekday(at: Date, timezone: string): boolean {
  const tz = resolveTimezone(timezone);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(at);
  return !['Sat', 'Sun'].includes(weekday);
}

/** Business hours: returns true when local time is in [start, end). */
export function isBusinessHours(
  at: Date,
  startHHMM: string,
  endHHMM: string,
  timezone: string,
): boolean {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  const now = minutesOfDay(at, timezone);
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute;
  return now >= s && now < e;
}
