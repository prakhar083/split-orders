import { describe, it, expect } from 'vitest';
import { parseINR, applyWindow } from '../src/util.js';

describe('parseINR', () => {
  it('parses rupee strings with symbol and commas', () => {
    expect(parseINR('₹1,234.50')).toBe(1234.5);
  });
  it('parses negative amounts', () => {
    expect(parseINR('-₹50')).toBe(-50);
  });
  it('returns 0 for empty/garbage', () => {
    expect(parseINR('')).toBe(0);
    expect(parseINR('Free')).toBe(0);
  });
});

describe('applyWindow', () => {
  const rows = [
    { placedAt: '2026-07-05T10:00:00.000Z', id: 'a' },
    { placedAt: '2026-07-01T10:00:00.000Z', id: 'b' },
    { placedAt: '2026-06-20T10:00:00.000Z', id: 'c' },
  ];
  it('filters by since (inclusive lower bound)', () => {
    expect(applyWindow(rows, { since: '2026-07-01' }).map(r => r.id)).toEqual(['a', 'b']);
  });
  it('caps by limit after filtering', () => {
    expect(applyWindow(rows, { limit: 2 }).map(r => r.id)).toEqual(['a', 'b']);
  });
});
