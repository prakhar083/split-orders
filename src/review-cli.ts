import { readFileSync } from 'node:fs';
import { dedupeItems, loadRules, saveRules, guessCategory, type Category, type Rules } from './categorize.js';
import type { NormalizedOrder } from './schema.js';

export function parseReviewArgs(argv: string[]): { ordersPath?: string; rulesPath: string; applyPath?: string } {
  const out: { ordersPath?: string; rulesPath: string; applyPath?: string } = { rulesPath: 'rules.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--orders') out.ordersPath = argv[++i];
    else if (a === '--rules') out.rulesPath = argv[++i];
    else if (a === '--apply') out.applyPath = argv[++i];
  }
  return out;
}

export function applyAnswers(applyPath: string, rulesPath: string): void {
  const answers = JSON.parse(readFileSync(applyPath, 'utf8')) as {
    name: string;
    shared: boolean;
    category?: Category;
  }[];
  const rules: Rules = loadRules(rulesPath);
  for (const a of answers) rules[a.name] = { category: a.category ?? guessCategory(a.name), shared: a.shared };
  saveRules(rulesPath, rules);
}

function main(): void {
  const args = parseReviewArgs(process.argv.slice(2));
  if (args.applyPath) {
    applyAnswers(args.applyPath, args.rulesPath);
    return;
  }
  if (!args.ordersPath) {
    console.error('Provide --orders <path> to list unmarked items, or --apply <path> to save answers.');
    process.exit(2);
  }
  const orders = JSON.parse(readFileSync(args.ordersPath, 'utf8')) as NormalizedOrder[];
  const rules = loadRules(args.rulesPath);
  const unmarked = dedupeItems(orders, rules).filter(i => !i.hasRule);
  const grouped: Record<string, { name: string }[]> = {};
  for (const item of unmarked) (grouped[item.category] ??= []).push({ name: item.name });
  process.stdout.write(JSON.stringify(grouped, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
