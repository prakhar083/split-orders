import { describe, it, expect } from 'vitest';
import { parseArgs, validateWindow, fetchFromSources } from '../src/cli.js';

describe('parseArgs', () => {
  it('parses sources, since, and limit', () => {
    const a = parseArgs(['--sources', 'amazon', '--since', '2026-07-01', '--limit', '5']);
    expect(a).toEqual({ sources: ['amazon'], since: '2026-07-01', limit: 5, mapZepto: false });
  });
  it('recognizes --map-zepto mode', () => {
    expect(parseArgs(['--map-zepto']).mapZepto).toBe(true);
  });
});

describe('validateWindow', () => {
  it('requires at least one of since/limit in scrape mode', () => {
    expect(validateWindow({ mapZepto: false })).toContain('provide at least one of --since or --limit');
  });
  it('accepts scrape mode with a limit', () => {
    expect(validateWindow({ limit: 3, mapZepto: false })).toEqual([]);
  });
  it('skips the window requirement in --map-zepto mode', () => {
    expect(validateWindow({ mapZepto: true })).toEqual([]);
  });
});

describe('fetchFromSources', () => {
  const order = (source: string) => ({ source, orderId: `${source}-1` }) as never;

  it('collects orders from every requested source', async () => {
    const got = await fetchFromSources(['amazon', 'blinkit'], {}, {
      amazon: async () => [order('amazon')],
      blinkit: async () => [order('blinkit')],
    });
    expect(got.orders.map(o => o.source)).toEqual(['amazon', 'blinkit']);
    expect(got.errors).toEqual([]);
  });

  it('isolates a failing source so the others still return', async () => {
    const got = await fetchFromSources(['amazon', 'blinkit'], {}, {
      amazon: async () => { throw new Error('boom'); },
      blinkit: async () => [order('blinkit')],
    });
    expect(got.orders.map(o => o.source)).toEqual(['blinkit']);
    expect(got.errors).toEqual(['amazon: boom']);
  });

  it('points zepto at the MCP path instead of reporting it as unknown', async () => {
    const got = await fetchFromSources(['zepto'], {}, {});
    expect(got.orders).toEqual([]);
    expect(got.errors[0]).toMatch(/--map-zepto/);
  });

  it('reports a genuinely unknown source', async () => {
    const got = await fetchFromSources(['swiggy'], {}, { amazon: async () => [] });
    expect(got.errors[0]).toMatch(/unknown source/);
  });
});
