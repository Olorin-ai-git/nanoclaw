import { describe, expect, it } from 'vitest';

import {
  isBusinessHours,
  isInQuietHours,
  isWeekday,
  parseHHMM,
} from './quiet-hours.js';

describe('parseHHMM', () => {
  it('parses valid HH:MM', () => {
    expect(parseHHMM('07:00')).toEqual({ hour: 7, minute: 0 });
    expect(parseHHMM('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseHHMM('00:00')).toEqual({ hour: 0, minute: 0 });
  });
  it('throws on invalid input', () => {
    expect(() => parseHHMM('24:00')).toThrow();
    expect(() => parseHHMM('7:0')).toThrow();
    expect(() => parseHHMM('junk')).toThrow();
  });
});

describe('isInQuietHours', () => {
  // 2026-04-13 is a Monday (ET morning)
  it('returns false during business hours in ET', () => {
    const at = new Date('2026-04-13T15:00:00.000Z'); // 11:00 ET (EDT, UTC-4)
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns true at midnight ET', () => {
    const at = new Date('2026-04-13T04:00:00.000Z'); // 00:00 ET
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(true);
  });
  it('returns true at 03:00 ET (inside quiet range)', () => {
    const at = new Date('2026-04-13T07:00:00.000Z'); // 03:00 ET
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(true);
  });
  it('returns false at exactly 07:00 ET (boundary — quiet ends)', () => {
    const at = new Date('2026-04-13T11:00:00.000Z'); // 07:00 ET
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns true at 23:30 ET (inside quiet range)', () => {
    const at = new Date('2026-04-14T03:30:00.000Z'); // 23:30 ET prior day
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(true);
  });
  it('handles non-wrapping quiet range (00:00 → 06:00)', () => {
    const at = new Date('2026-04-13T08:00:00.000Z'); // 04:00 ET
    expect(isInQuietHours(at, '00:00', '06:00', 'America/New_York')).toBe(true);
    const daytime = new Date('2026-04-13T15:00:00.000Z'); // 11:00 ET
    expect(isInQuietHours(daytime, '00:00', '06:00', 'America/New_York')).toBe(
      false,
    );
  });
});

describe('isWeekday', () => {
  it('returns true Mon-Fri in ET', () => {
    // Mon 2026-04-13 15:00 UTC = 11:00 ET
    expect(
      isWeekday(new Date('2026-04-13T15:00:00.000Z'), 'America/New_York'),
    ).toBe(true);
    // Fri 2026-04-17 15:00 UTC
    expect(
      isWeekday(new Date('2026-04-17T15:00:00.000Z'), 'America/New_York'),
    ).toBe(true);
  });
  it('returns false on Saturday in ET', () => {
    // Sat 2026-04-18 15:00 UTC
    expect(
      isWeekday(new Date('2026-04-18T15:00:00.000Z'), 'America/New_York'),
    ).toBe(false);
  });
  it('returns false on Sunday in ET', () => {
    // Sun 2026-04-19 15:00 UTC
    expect(
      isWeekday(new Date('2026-04-19T15:00:00.000Z'), 'America/New_York'),
    ).toBe(false);
  });
});

describe('isBusinessHours', () => {
  it('returns true within 08:00-18:00 ET', () => {
    const at = new Date('2026-04-13T15:00:00.000Z'); // 11:00 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      true,
    );
  });
  it('returns false at 07:00 ET (before start)', () => {
    const at = new Date('2026-04-13T11:00:00.000Z'); // 07:00 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns false at 18:00 ET (at end — exclusive)', () => {
    const at = new Date('2026-04-13T22:00:00.000Z'); // 18:00 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns true at 17:59 ET', () => {
    const at = new Date('2026-04-13T21:59:00.000Z'); // 17:59 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      true,
    );
  });
});
