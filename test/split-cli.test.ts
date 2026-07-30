import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import {
  parseSplitArgs,
  loadConfig,
  splitOrders,
  postResults,
  describeSplit,
  detailsFor,
  perPersonAmount,
  type PostOutcome,
} from '../src/split-cli.js';
import { saveRules } from '../src/categorize.js';
import type { SplitResult } from '../src/split.js';

const ORDERS = new URL('./fixtures/split-orders.json', import.meta.url).pathname;
const RULES = new URL('./fixtures/tmp-split-cli-rules.json', import.meta.url).pathname;
const CONFIG = new URL('./fixtures/tmp-split-cli-config.json', import.meta.url).pathname;

afterEach(() => {
  for (const p of [RULES, CONFIG]) if (existsSync(p)) unlinkSync(p);
});

function result(orderId: string, splitAmount = 100): SplitResult {
  return {
    orderId,
    source: 'zepto',
    placedAt: '2026-07-16T09:39:46.879Z',
    sharedItems: [],
    personalItems: [],
    splitAmount,
    sharedRatio: 1,
  };
}

describe('parseSplitArgs', () => {
  it('parses --split with --rules', () => {
    expect(parseSplitArgs(['--split', ORDERS, '--rules', RULES])).toEqual({
      mode: 'split', ordersPath: ORDERS, rulesPath: RULES, configPath: 'config.json', resultsPath: undefined,
    });
  });

  it('parses --post with --config', () => {
    expect(parseSplitArgs(['--post', '/tmp/r.json', '--config', CONFIG])).toEqual({
      mode: 'post', resultsPath: '/tmp/r.json', rulesPath: 'rules.json', configPath: CONFIG, ordersPath: undefined,
    });
  });

  it('defaults rules.json and config.json and leaves mode undefined with no args', () => {
    expect(parseSplitArgs([])).toEqual({ rulesPath: 'rules.json', configPath: 'config.json' });
  });
});

describe('loadConfig', () => {
  it('returns trimmed values for a complete config', () => {
    writeFileSync(CONFIG, JSON.stringify({ splitwiseApiKey: ' abc ', splitwiseGroupName: 'Flatmates' }));
    expect(loadConfig(CONFIG)).toEqual({ splitwiseApiKey: 'abc', splitwiseGroupName: 'Flatmates' });
  });

  it('throws naming the missing key when the api key is empty', () => {
    writeFileSync(CONFIG, JSON.stringify({ splitwiseApiKey: '', splitwiseGroupName: 'Flatmates' }));
    expect(() => loadConfig(CONFIG)).toThrow(/splitwiseApiKey/);
  });

  it('throws naming the missing key when the group name is absent', () => {
    writeFileSync(CONFIG, JSON.stringify({ splitwiseApiKey: 'abc' }));
    expect(() => loadConfig(CONFIG)).toThrow(/splitwiseGroupName/);
  });

  it('throws a config-not-found error when the file is missing', () => {
    expect(() => loadConfig(CONFIG)).toThrow(/config\.example\.json/);
  });
});

describe('splitOrders', () => {
  it('returns one result per order with something shared, dropping the rest', () => {
    saveRules(RULES, { 'Amul Dahi': { category: 'grocery', shared: true } });
    const results = splitOrders(ORDERS, RULES);
    expect(results).toHaveLength(1);
    expect(results[0].orderId).toBe('ORD-1');
    expect(results[0].splitAmount).toBe(80);
  });

  it('returns an empty array when nothing is shared', () => {
    saveRules(RULES, { 'Amul Dahi': { category: 'grocery', shared: false } });
    expect(splitOrders(ORDERS, RULES)).toEqual([]);
  });
});

describe('postResults', () => {
  it('posts every result in order and reports expense ids', async () => {
    const seen: string[] = [];
    let next = 1;
    const outcomes = await postResults([result('A'), result('B')], async r => {
      seen.push(r.orderId);
      return { id: next++ };
    });
    expect(seen).toEqual(['A', 'B']);
    expect(outcomes).toEqual([
      { orderId: 'A', status: 'posted', expenseId: 1 },
      { orderId: 'B', status: 'posted', expenseId: 2 },
    ]);
  });

  it('stops on the first failure and reports what did and did not post', async () => {
    const attempted: string[] = [];
    const outcomes = await postResults([result('A'), result('B'), result('C')], async r => {
      attempted.push(r.orderId);
      if (r.orderId === 'B') throw new Error('Splitwise rejected the expense');
      return { id: 7 };
    });
    expect(attempted).toEqual(['A', 'B']);
    expect(outcomes).toEqual([
      { orderId: 'A', status: 'posted', expenseId: 7 },
      { orderId: 'B', status: 'failed', error: 'Splitwise rejected the expense' },
    ]);
  });

  it('reports progress for each outcome as it goes', async () => {
    const progress: PostOutcome[] = [];
    await postResults([result('A'), result('B')], async () => ({ id: 5 }), o => progress.push(o));
    expect(progress.map(o => o.orderId)).toEqual(['A', 'B']);
  });
});

describe('description, details and per-person amount', () => {
  it('builds a description from source, placedAt and orderId', () => {
    expect(describeSplit(result('ORD-1'))).toBe('zepto order 2026-07-16T09:39:46.879Z — ORD-1');
  });

  it('builds a machine-readable details tag for duplicate detection', () => {
    expect(detailsFor(result('ORD-1'))).toBe('order:zepto:ORD-1');
  });

  it('divides the split amount across group members, rounded to paise', () => {
    expect(perPersonAmount(92, 2)).toBe(46);
    expect(perPersonAmount(100, 3)).toBe(33.33);
  });
});
