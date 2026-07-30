import { readFileSync } from 'node:fs';
import { loadRules } from './categorize.js';
import { computeSplit, round2, type SplitResult } from './split.js';
import { createExpense, findGroup, type SplitwiseGroup } from './splitwise.js';
import type { NormalizedOrder } from './schema.js';

export interface SplitCliArgs {
  mode?: 'split' | 'post';
  ordersPath?: string;
  rulesPath: string;
  resultsPath?: string;
  configPath: string;
}

export function parseSplitArgs(argv: string[]): SplitCliArgs {
  const out: SplitCliArgs = { rulesPath: 'rules.json', configPath: 'config.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--split') {
      out.mode = 'split';
      out.ordersPath = argv[++i];
    } else if (a === '--post') {
      out.mode = 'post';
      out.resultsPath = argv[++i];
    } else if (a === '--rules') out.rulesPath = argv[++i];
    else if (a === '--config') out.configPath = argv[++i];
  }
  return out;
}

export interface Config {
  splitwiseApiKey: string;
  splitwiseGroupName: string;
}

export function loadConfig(path: string): Config {
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  } catch {
    throw new Error(`Could not read config at ${path}. Copy config.example.json to config.json and fill it in.`);
  }
  const missing: string[] = [];
  if (!parsed.splitwiseApiKey?.trim()) missing.push('splitwiseApiKey');
  if (!parsed.splitwiseGroupName?.trim()) missing.push('splitwiseGroupName');
  if (missing.length) {
    throw new Error(
      `Config at ${path} is missing: ${missing.join(', ')}. See config.example.json (API key from https://dev.splitwise.com).`,
    );
  }
  return { splitwiseApiKey: parsed.splitwiseApiKey!.trim(), splitwiseGroupName: parsed.splitwiseGroupName!.trim() };
}

export function splitOrders(ordersPath: string, rulesPath: string): SplitResult[] {
  const orders = JSON.parse(readFileSync(ordersPath, 'utf8')) as NormalizedOrder[];
  const rules = loadRules(rulesPath);
  const results: SplitResult[] = [];
  for (const order of orders) {
    const result = computeSplit(order, rules);
    if (result) results.push(result);
  }
  return results;
}

export function describeSplit(result: SplitResult): string {
  return `${result.source} order ${result.placedAt} — ${result.orderId}`;
}

export function detailsFor(result: SplitResult): string {
  return `order:${result.source}:${result.orderId}`;
}

export interface PostOutcome {
  orderId: string;
  status: 'posted' | 'failed';
  expenseId?: number;
  error?: string;
}

export type Poster = (result: SplitResult) => Promise<{ id: number }>;

export async function postResults(
  results: SplitResult[],
  post: Poster,
  onProgress: (outcome: PostOutcome) => void = () => {},
): Promise<PostOutcome[]> {
  const outcomes: PostOutcome[] = [];
  for (const result of results) {
    let outcome: PostOutcome;
    try {
      const { id } = await post(result);
      outcome = { orderId: result.orderId, status: 'posted', expenseId: id };
    } catch (e) {
      outcome = { orderId: result.orderId, status: 'failed', error: (e as Error).message };
    }
    outcomes.push(outcome);
    onProgress(outcome);
    if (outcome.status === 'failed') break;
  }
  return outcomes;
}

export function perPersonAmount(splitAmount: number, memberCount: number): number {
  if (memberCount <= 0) return splitAmount;
  return round2(splitAmount / memberCount);
}

async function main(): Promise<void> {
  const args = parseSplitArgs(process.argv.slice(2));

  if (args.mode === 'split') {
    process.stdout.write(JSON.stringify(splitOrders(args.ordersPath!, args.rulesPath), null, 2) + '\n');
    return;
  }

  if (args.mode === 'post') {
    const config = loadConfig(args.configPath);
    const results = JSON.parse(readFileSync(args.resultsPath!, 'utf8')) as SplitResult[];
    const group: SplitwiseGroup = await findGroup(config.splitwiseApiKey, config.splitwiseGroupName);
    const outcomes = await postResults(
      results,
      r =>
        createExpense(config.splitwiseApiKey, group, {
          description: describeSplit(r),
          amount: r.splitAmount,
          date: r.placedAt,
          details: detailsFor(r),
        }),
      o => console.error(JSON.stringify(o)),
    );
    process.stdout.write(JSON.stringify(outcomes, null, 2) + '\n');
    if (outcomes.some(o => o.status === 'failed')) process.exit(1);
    return;
  }

  console.error(
    'Usage:\n' +
      '  --split <orders.json> [--rules rules.json]\n' +
      '  --post <split-results.json> [--config config.json]',
  );
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
