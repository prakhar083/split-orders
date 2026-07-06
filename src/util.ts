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
