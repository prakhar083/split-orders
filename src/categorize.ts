import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { NormalizedOrder } from './schema.js';

export type Category = 'grocery' | 'personal-hygiene' | 'tobacco-alcohol' | 'household' | 'other';

export interface Rule {
  category: Category;
  shared: boolean;
}

export type Rules = Record<string, Rule>;

const KEYWORDS: [RegExp, Category][] = [
  [/cigarette|tobacco|beedi|vape|whisky|whiskey|wine|beer|vodka|rum\b/i, 'tobacco-alcohol'],
  [/shampoo|soap|toothpaste|toothbrush|deodorant|razor|sanitary|diaper|hygiene/i, 'personal-hygiene'],
  [/detergent|dishwash|cleaner|mop|tissue|garbage bag|room freshener/i, 'household'],
  [/milk|bread|egg|vegetable|fruit|dahi|curd|paneer|rice|atta|flour|oil|masala|noodles|cauliflower|onion|tomato|chilli|coriander|snack|biscuit|juice|cola|soda|energy drink|chips|namkeen|bhujia|kaju|nuts/i, 'grocery'],
];

export function guessCategory(itemName: string): Category {
  for (const [re, cat] of KEYWORDS) if (re.test(itemName)) return cat;
  return 'other';
}

export function loadRules(path: string): Rules {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Rules;
}

export function saveRules(path: string, rules: Rules): void {
  writeFileSync(path, JSON.stringify(rules, null, 2) + '\n', 'utf8');
}

export interface DedupedItem {
  name: string;
  category: Category;
  hasRule: boolean;
}

export function dedupeItems(
  orders: NormalizedOrder[],
  rules: Rules,
): DedupedItem[] {
  const seen = new Map<string, DedupedItem>();
  for (const order of orders) {
    for (const item of order.items) {
      if (seen.has(item.name)) continue;
      const rule = rules[item.name];
      seen.set(item.name, {
        name: item.name,
        category: rule ? rule.category : guessCategory(item.name),
        hasRule: !!rule,
      });
    }
  }
  return [...seen.values()];
}
