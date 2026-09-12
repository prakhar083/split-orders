import * as cheerio from 'cheerio';

export function parseINR(text: string): number {
  const cleaned = (text ?? '').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function applyWindow<T extends { placedAt: string }>(
  entries: T[],
  opts: { since?: string; limit?: number },
): T[] {
  let out = [...entries].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  if (opts.since) {
    const since = new Date(opts.since).getTime();
    out = out.filter(e => new Date(e.placedAt).getTime() >= since);
  }
  if (opts.limit != null) out = out.slice(0, opts.limit);
  return out;
}

/** Strip a page down to a single whitespace-collapsed text line for regex parsing. */
export function flatText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style').remove();
  return $('body').text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Actual amount paid = the lowest value in a run of `\u20b9X\u20b9Y…` (paid vs struck MRP). */
export function paid(prices: string): number {
  const nums = (prices.match(/\u20b9[\d,]+/g) ?? []).map(parseINR);
  return nums.length ? Math.min(...nums) : 0;
}
