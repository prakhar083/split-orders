import { describe, it, expect } from 'vitest';
import { parseINR, applyWindow, flatText, paid } from '../src/util.js';

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

describe('flatText', () => {
  it('drops script/style content and collapses whitespace', () => {
    const html = '<body><script>var x = 1</script><p>Hello\u00a0\u00a0 world</p><style>a{color:red}</style></body>';
    expect(flatText(html)).toBe('Hello world');
  });
  it('flattens nested markup into a single spaced line', () => {
    expect(flatText('<body><div><b>A</b>\n  <span>B</span></div></body>')).toBe('A B');
  });
});

describe('paid', () => {
  it('takes the lowest value in a paid-vs-struck-MRP run', () => {
    expect(paid('\u20b91,200\u20b91,500')).toBe(1200);
  });
  it('handles a lone price', () => {
    expect(paid('\u20b999')).toBe(99);
  });
  it('returns 0 when there is no price', () => {
    expect(paid('Free')).toBe(0);
  });
});
