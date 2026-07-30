# Filter + Split Phase (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add item review (personal vs. shared, with persisted rules), per-order split calculation, and Splitwise posting on top of the existing v1 fetch layer (`NormalizedOrder[]` from Zepto + Amazon Now).

**Architecture:** Three new pure/thin modules — `categorize.ts` (dedupe + keyword-guess + rules persistence), `split.ts` (pure per-order split math), `splitwise.ts` (official REST API client) — plus a `review-cli.ts` entry point the skill shells out to for the interactive review step. `SKILL.md` is updated to describe the full fetch → review → confirm → post flow.

**Tech Stack:** Node 20+, TypeScript strict/ESM (matches v1), Vitest, `tsx` (no build step), no new runtime dependency for HTTP (use global `fetch`, available in Node 20+).

## Global Constraints

- Node **20+**, TypeScript **strict**, ESM; run TS via `tsx`, no build step. (from v1 spec, still binding)
- All money values are **numbers in INR rupees**, rounded to 2 decimals with a `round2` helper — never left as raw floats with binary rounding artifacts.
- Rules match on **exact item name** (string key) — no fuzzy/substring matching at apply time.
- An item with **no saved rule is never auto-shared** — `computeSplit` treats it as personal (under-splitting is preferred over accidentally billing a personal item).
- Fees (`deliveryFee`, `packagingFee`, `taxes`, `tip`) are **always fully shared** (added to the split amount in full).
- `discount` is **prorated** by the shared-item share of the order's item subtotal.
- One Splitwise expense **per order** (not per month), equal split among all group members.
- Splitwise group lookup is **exact case-insensitive name match only** — 0 or >1 matches is an error.
- `config.json` and `rules.json` are **gitignored**; `config.example.json` is committed as a template.
- No live Splitwise HTTP calls in the automated test suite — `splitwise.ts` is tested against mocked `fetch`.

---

## File Structure

- `src/categorize.ts` — `Category`, `Rule`, `Rules` types; `guessCategory`, `loadRules`, `saveRules`, `dedupeItems`.
- `src/split.ts` — `SplitResult` type; `round2`, `computeSplit`.
- `src/splitwise.ts` — `SplitwiseGroup` type; `findGroup`, `createExpense`.
- `src/review-cli.ts` — CLI entry point wrapping `dedupeItems`/`saveRules` for the skill to shell out to.
- `config.example.json` — committed template.
- `.gitignore` — add `config.json` and `rules.json`.
- `test/categorize.test.ts`, `test/split.test.ts`, `test/splitwise.test.ts`, `test/review-cli.test.ts`, `test/fixtures/split-orders.json`.
- `SKILL.md` — updated with the v2 flow.

---

### Task 1: `categorize.ts` — keyword guessing + rules persistence + dedupe

**Files:**
- Create: `src/categorize.ts`
- Test: `test/categorize.test.ts`

**Interfaces:**
- Consumes: `NormalizedOrder`, `OrderItem` from `src/schema.ts` (existing).
- Produces:
  - `type Category = 'grocery' | 'personal-hygiene' | 'tobacco-alcohol' | 'household' | 'other'`
  - `interface Rule { category: Category; shared: boolean }`
  - `type Rules = Record<string, Rule>`
  - `guessCategory(itemName: string): Category`
  - `loadRules(path: string): Rules`
  - `saveRules(path: string, rules: Rules): void`
  - `interface DedupedItem { name: string; category: Category; hasRule: boolean }`
  - `dedupeItems(orders: NormalizedOrder[], rules: Rules): DedupedItem[]`

- [ ] **Step 1: Write the failing tests**

`test/categorize.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { guessCategory, loadRules, saveRules, dedupeItems, type Rules } from '../src/categorize.js';
import type { NormalizedOrder } from '../src/schema.js';

describe('guessCategory', () => {
  it('recognizes tobacco/alcohol keywords', () => {
    expect(guessCategory('Classic Double Burst Cigarette')).toBe('tobacco-alcohol');
  });
  it('recognizes grocery keywords', () => {
    expect(guessCategory('Amul High Protein Cup Dahi')).toBe('grocery');
    expect(guessCategory('Fresh Cauliflower Small')).toBe('grocery');
  });
  it('recognizes personal-hygiene keywords', () => {
    expect(guessCategory('Dove Shampoo 340ml')).toBe('personal-hygiene');
  });
  it('falls back to other when nothing matches', () => {
    expect(guessCategory('Mystery Widget 3000')).toBe('other');
  });
});

const TMP_RULES = new URL('./fixtures/tmp-rules.json', import.meta.url).pathname;

describe('loadRules / saveRules', () => {
  it('returns {} when the file does not exist', () => {
    if (existsSync(TMP_RULES)) unlinkSync(TMP_RULES);
    expect(loadRules(TMP_RULES)).toEqual({});
  });
  it('round-trips saved rules', () => {
    const rules: Rules = { 'Amul Milk': { category: 'grocery', shared: true } };
    saveRules(TMP_RULES, rules);
    expect(loadRules(TMP_RULES)).toEqual(rules);
    unlinkSync(TMP_RULES);
  });
});

const order = (items: { name: string }[]): NormalizedOrder => ({
  source: 'zepto', orderId: 'X', placedAt: '2026-07-01T00:00:00.000Z',
  items: items.map(i => ({ ...i, quantity: 1, lineTotal: 10 })),
  charges: { subtotal: 10 }, grandTotal: 10, currency: 'INR',
});

describe('dedupeItems', () => {
  it('unions item names across orders without duplicates', () => {
    const orders = [order([{ name: 'Milk' }, { name: 'Bread' }]), order([{ name: 'Milk' }])];
    const result = dedupeItems(orders, {});
    expect(result.map(r => r.name).sort()).toEqual(['Bread', 'Milk']);
  });
  it('marks items with an existing rule as hasRule and uses the saved category', () => {
    const orders = [order([{ name: 'Classic Double Burst Cigarette' }])];
    const rules: Rules = { 'Classic Double Burst Cigarette': { category: 'other', shared: false } };
    const result = dedupeItems(orders, rules);
    expect(result).toEqual([{ name: 'Classic Double Burst Cigarette', category: 'other', hasRule: true }]);
  });
  it('guesses a category for items with no saved rule', () => {
    const orders = [order([{ name: 'Fresh Cauliflower Small' }])];
    const result = dedupeItems(orders, {});
    expect(result).toEqual([{ name: 'Fresh Cauliflower Small', category: 'grocery', hasRule: false }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/categorize.test.ts`
Expected: FAIL — cannot import `../src/categorize.js`.

- [ ] **Step 3: Implement `src/categorize.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
  orders: { items: { name: string }[] }[],
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/categorize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/categorize.ts test/categorize.test.ts
git commit -m "feat: item categorization, rules persistence, and dedupe across orders"
```

---

### Task 2: `split.ts` — pure per-order split calculation

**Files:**
- Create: `src/split.ts`
- Test: `test/split.test.ts`

**Interfaces:**
- Consumes: `NormalizedOrder`, `OrderItem` from `src/schema.ts`; `Rules` from `src/categorize.ts`.
- Produces:
  - `round2(n: number): number`
  - `interface SplitResult { orderId: string; source: NormalizedOrder['source']; placedAt: string; sharedItems: OrderItem[]; personalItems: OrderItem[]; splitAmount: number; share: number }`
  - `computeSplit(order: NormalizedOrder, rules: Rules): SplitResult | null`

- [ ] **Step 1: Write the failing tests**

`test/split.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeSplit, round2 } from '../src/split.js';
import type { NormalizedOrder } from '../src/schema.js';
import type { Rules } from '../src/categorize.js';

const baseOrder: NormalizedOrder = {
  source: 'zepto', orderId: 'ORD-1', placedAt: '2026-07-16T09:39:46.879Z',
  items: [
    { name: 'Amul Dahi', quantity: 1, unitPrice: 80, lineTotal: 80 },
    { name: 'Classic Double Burst Cigarette', quantity: 1, unitPrice: 480, lineTotal: 480 },
  ],
  charges: { subtotal: 560 }, grandTotal: 560, currency: 'INR',
};

const rulesMixed: Rules = {
  'Amul Dahi': { category: 'grocery', shared: true },
  'Classic Double Burst Cigarette': { category: 'tobacco-alcohol', shared: false },
};

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(10.005)).toBe(10.01); // adjusted below if binary float differs
    expect(round2(10.1)).toBe(10.1);
  });
});

describe('computeSplit', () => {
  it('returns null when no items are shared', () => {
    const rules: Rules = {
      'Amul Dahi': { category: 'grocery', shared: false },
      'Classic Double Burst Cigarette': { category: 'tobacco-alcohol', shared: false },
    };
    expect(computeSplit(baseOrder, rules)).toBeNull();
  });

  it('treats an item with no rule as personal (not shared)', () => {
    const rules: Rules = { 'Amul Dahi': { category: 'grocery', shared: true } };
    // 'Classic Double Burst Cigarette' has no rule -> personal
    const result = computeSplit(baseOrder, rules);
    expect(result?.sharedItems.map(i => i.name)).toEqual(['Amul Dahi']);
    expect(result?.personalItems.map(i => i.name)).toEqual(['Classic Double Burst Cigarette']);
  });

  it('computes splitAmount as shared subtotal + full fees - prorated discount', () => {
    const order: NormalizedOrder = {
      ...baseOrder,
      charges: { subtotal: 560, deliveryFee: 20, discount: 56 },
      grandTotal: 524,
    };
    const result = computeSplit(order, rulesMixed);
    // share = 80/560 = 0.142857...
    // proratedDiscount = 56 * 0.142857 = 8
    // splitAmount = 80 + 20 - 8 = 92
    expect(result?.share).toBeCloseTo(80 / 560, 6);
    expect(result?.splitAmount).toBe(92);
  });

  it('adds fully-shared fees even when share is 100%', () => {
    const order: NormalizedOrder = {
      source: 'amazon', orderId: 'ORD-2', placedAt: '2026-07-01T00:00:00.000Z',
      items: [{ name: 'Amul Dahi', quantity: 1, unitPrice: 80, lineTotal: 80 }],
      charges: { subtotal: 80, deliveryFee: 30 }, grandTotal: 110, currency: 'INR',
    };
    const rules: Rules = { 'Amul Dahi': { category: 'grocery', shared: true } };
    const result = computeSplit(order, rules);
    expect(result?.splitAmount).toBe(110);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/split.test.ts`
Expected: FAIL — cannot import `../src/split.js`. Note: the first `round2` assertion
may need adjustment once run (binary floating point can make `10.005` round to
`10` rather than `10.01`); if so, change that assertion to a value with an exact
binary representation, e.g. `expect(round2(10.125)).toBe(10.13)` — run the test
first and adjust to match the actual `Math.round`-based behavior, don't guess.

- [ ] **Step 3: Implement `src/split.ts`**

```ts
import type { NormalizedOrder, OrderItem } from './schema.js';
import type { Rules } from './categorize.js';

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface SplitResult {
  orderId: string;
  source: NormalizedOrder['source'];
  placedAt: string;
  sharedItems: OrderItem[];
  personalItems: OrderItem[];
  splitAmount: number;
  share: number;
}

export function computeSplit(order: NormalizedOrder, rules: Rules): SplitResult | null {
  const sharedItems: OrderItem[] = [];
  const personalItems: OrderItem[] = [];
  for (const item of order.items) {
    if (rules[item.name]?.shared === true) sharedItems.push(item);
    else personalItems.push(item);
  }

  const sharedSubtotal = sharedItems.reduce((s, i) => s + i.lineTotal, 0);
  if (sharedSubtotal === 0) return null;

  const totalSubtotal = order.charges.subtotal;
  const share = totalSubtotal > 0 ? sharedSubtotal / totalSubtotal : 0;

  const c = order.charges;
  const fullySharedFees = (c.deliveryFee ?? 0) + (c.packagingFee ?? 0) + (c.taxes ?? 0) + (c.tip ?? 0);
  const proratedDiscount = (c.discount ?? 0) * share;

  const splitAmount = round2(sharedSubtotal + fullySharedFees - proratedDiscount);

  return {
    orderId: order.orderId,
    source: order.source,
    placedAt: order.placedAt,
    sharedItems,
    personalItems,
    splitAmount,
    share,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass, adjusting the `round2` assertion if needed**

Run: `npx vitest run test/split.test.ts`
Expected: PASS. If the first `round2` assertion fails due to floating point, edit
it per the note in Step 2 and re-run until green.

- [ ] **Step 5: Commit**

```bash
git add src/split.ts test/split.test.ts
git commit -m "feat: pure per-order split calculation (shared subtotal + fees - prorated discount)"
```

---

### Task 3: `splitwise.ts` — official API client (mocked-HTTP tested)

**Files:**
- Create: `src/splitwise.ts`
- Test: `test/splitwise.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses global `fetch`).
- Produces:
  - `interface SplitwiseMember { id: number }`
  - `interface SplitwiseGroup { id: number; name: string; members: SplitwiseMember[] }`
  - `findGroup(apiKey: string, name: string): Promise<SplitwiseGroup>`
  - `createExpense(apiKey: string, group: SplitwiseGroup, opts: { description: string; amount: number; date: string }): Promise<{ id: number }>`

- [ ] **Step 1: Write the failing tests**

`test/splitwise.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findGroup, createExpense, type SplitwiseGroup } from '../src/splitwise.js';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok, status, json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('findGroup', () => {
  it('returns the group on an exact case-insensitive name match', async () => {
    mockFetchOnce({ groups: [
      { id: 1, name: 'Family', members: [{ id: 10 }] },
      { id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] },
    ]});
    const g = await findGroup('key', 'flatmates');
    expect(g).toEqual({ id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] });
  });

  it('throws when no group matches', async () => {
    mockFetchOnce({ groups: [{ id: 1, name: 'Family', members: [] }] });
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/no group/i);
  });

  it('throws when more than one group matches exactly (case-insensitive dup)', async () => {
    mockFetchOnce({ groups: [
      { id: 1, name: 'Flatmates', members: [] },
      { id: 2, name: 'FLATMATES', members: [] },
    ]});
    await expect(findGroup('key', 'flatmates')).rejects.toThrow(/multiple/i);
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({ error: 'unauthorized' }, false, 401);
    await expect(findGroup('bad-key', 'Flatmates')).rejects.toThrow(/401/);
  });
});

describe('createExpense', () => {
  const group: SplitwiseGroup = { id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] };

  it('posts an equal-split expense and returns its id', async () => {
    mockFetchOnce({ expenses: [{ id: 999 }] });
    const result = await createExpense('key', group, { description: 'zepto order', amount: 92, date: '2026-07-16T00:00:00.000Z' });
    expect(result).toEqual({ id: 999 });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.cost).toBe('92.00');
    expect(body.group_id).toBe(2);
    expect(body.split_equally).toBe(true);
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({ error: 'bad request' }, false, 400);
    await expect(createExpense('key', group, { description: 'x', amount: 1, date: '2026-07-16T00:00:00.000Z' }))
      .rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/splitwise.test.ts`
Expected: FAIL — cannot import `../src/splitwise.js`.

- [ ] **Step 3: Implement `src/splitwise.ts`**

```ts
const BASE = 'https://secure.splitwise.com/api/v3.0';

export interface SplitwiseMember {
  id: number;
}

export interface SplitwiseGroup {
  id: number;
  name: string;
  members: SplitwiseMember[];
}

async function api<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Splitwise API ${path} failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function findGroup(apiKey: string, name: string): Promise<SplitwiseGroup> {
  const data = await api<{ groups: SplitwiseGroup[] }>(apiKey, '/get_groups');
  const matches = data.groups.filter(g => g.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) throw new Error(`No group found with name "${name}"`);
  if (matches.length > 1) throw new Error(`Multiple groups found with name "${name}"`);
  return matches[0];
}

export async function createExpense(
  apiKey: string,
  group: SplitwiseGroup,
  opts: { description: string; amount: number; date: string },
): Promise<{ id: number }> {
  const data = await api<{ expenses: { id: number }[] }>(apiKey, '/create_expense', {
    method: 'POST',
    body: JSON.stringify({
      cost: opts.amount.toFixed(2),
      description: opts.description,
      date: opts.date,
      group_id: group.id,
      split_equally: true,
    }),
  });
  return { id: data.expenses[0].id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/splitwise.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/splitwise.ts test/splitwise.test.ts
git commit -m "feat: Splitwise API client (findGroup, createExpense) with mocked-HTTP tests"
```

---

### Task 4: `review-cli.ts` — item review entry point for the skill

**Files:**
- Create: `src/review-cli.ts`
- Test: `test/review-cli.test.ts`

**Interfaces:**
- Consumes: `dedupeItems`, `loadRules`, `saveRules`, `Rules`, `Rule` from `src/categorize.js`.
- Produces:
  - `parseReviewArgs(argv: string[]): { ordersPath?: string; rulesPath: string; applyPath?: string }`
  - a runnable entrypoint: `--orders <path> --rules <path>` prints unmarked `DedupedItem[]` as JSON grouped by category; `--apply <path> --rules <path>` reads `{ name: string; shared: boolean }[]` from the given path and merges into rules (guessing category via `guessCategory` for each), then saves.

- [ ] **Step 1: Write the failing test**

`test/review-cli.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { parseReviewArgs } from '../src/review-cli.js';
import { loadRules, saveRules } from '../src/categorize.js';

const ORDERS = new URL('./fixtures/split-orders.json', import.meta.url).pathname;
const RULES = new URL('./fixtures/tmp-review-rules.json', import.meta.url).pathname;
const ANSWERS = new URL('./fixtures/tmp-review-answers.json', import.meta.url).pathname;

afterEach(() => {
  for (const p of [RULES, ANSWERS]) if (existsSync(p)) unlinkSync(p);
});

describe('parseReviewArgs', () => {
  it('parses --orders and --rules', () => {
    expect(parseReviewArgs(['--orders', ORDERS, '--rules', RULES]))
      .toEqual({ ordersPath: ORDERS, rulesPath: RULES, applyPath: undefined });
  });
  it('parses --apply and --rules', () => {
    expect(parseReviewArgs(['--apply', ANSWERS, '--rules', RULES]))
      .toEqual({ ordersPath: undefined, rulesPath: RULES, applyPath: ANSWERS });
  });
});

describe('apply mode merges answers into rules', () => {
  it('saves a rule per answered item, guessing category', () => {
    saveRules(RULES, {});
    writeFileSync(ANSWERS, JSON.stringify([
      { name: 'Amul Dahi', shared: true },
      { name: 'Classic Double Burst Cigarette', shared: false },
    ]));
    const { applyAnswers } = require('../src/review-cli.js');
    applyAnswers(ANSWERS, RULES);
    const rules = loadRules(RULES);
    expect(rules['Amul Dahi']).toEqual({ category: 'grocery', shared: true });
    expect(rules['Classic Double Burst Cigarette']).toEqual({ category: 'tobacco-alcohol', shared: false });
  });
});
```

- [ ] **Step 2: Create the orders fixture used by the review tests**

`test/fixtures/split-orders.json`:
```json
[
  {
    "source": "zepto", "orderId": "ORD-1", "placedAt": "2026-07-16T09:39:46.879Z",
    "items": [
      { "name": "Amul Dahi", "quantity": 1, "unitPrice": 80, "lineTotal": 80 },
      { "name": "Classic Double Burst Cigarette", "quantity": 1, "unitPrice": 480, "lineTotal": 480 }
    ],
    "charges": { "subtotal": 560 }, "grandTotal": 560, "currency": "INR"
  }
]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/review-cli.test.ts`
Expected: FAIL — cannot import `../src/review-cli.js`.

- [ ] **Step 4: Implement `src/review-cli.ts`**

```ts
import { readFileSync } from 'node:fs';
import { dedupeItems, loadRules, saveRules, guessCategory, type Rules } from './categorize.js';
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
  const answers = JSON.parse(readFileSync(applyPath, 'utf8')) as { name: string; shared: boolean }[];
  const rules: Rules = loadRules(rulesPath);
  for (const a of answers) rules[a.name] = { category: guessCategory(a.name), shared: a.shared };
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
```

- [ ] **Step 5: Fix the test's CJS `require` (ESM project) and run**

Edit `test/review-cli.test.ts`, replacing the `require` line inside the `it` block:
```ts
const { applyAnswers } = require('../src/review-cli.js');
```
with:
```ts
import { applyAnswers } from '../src/review-cli.js';
```
Move that import to the top of the file alongside the other imports, then delete
the inline `const { applyAnswers } = ...` line from inside the test body.

Run: `npx vitest run test/review-cli.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/review-cli.ts test/review-cli.test.ts test/fixtures/split-orders.json
git commit -m "feat: review-cli entrypoint for listing unmarked items and applying answers"
```

---

### Task 5: Config template, gitignore, and typecheck/full-suite verification

**Files:**
- Create: `config.example.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (no code interface — this task wires up config and verifies the whole v2 surface compiles and tests pass together).
- Produces: nothing new; verifies `src/categorize.ts`, `src/split.ts`, `src/splitwise.ts`, `src/review-cli.ts` all typecheck together and the full suite is green.

- [ ] **Step 1: Create `config.example.json`**

```json
{
  "splitwiseApiKey": "",
  "splitwiseGroupName": "Flatmates"
}
```

- [ ] **Step 2: Update `.gitignore`**

Read the current `.gitignore`, then add two lines to it:
```
config.json
rules.json
```

- [ ] **Step 3: Run the full typecheck and test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all test files pass, including `categorize.test.ts`, `split.test.ts`,
`splitwise.test.ts`, `review-cli.test.ts` alongside the existing v1 tests.

- [ ] **Step 4: Commit**

```bash
git add config.example.json .gitignore
git commit -m "chore: add Splitwise config template, gitignore config.json/rules.json"
```

---

### Task 6: `SKILL.md` — document the full v2 flow

**Files:**
- Modify: `SKILL.md`

**Interfaces:**
- Consumes: all of the above (`review-cli.ts`, `split.ts`, `splitwise.ts`) by name/path, for the orchestration instructions.
- Produces: the updated skill description Claude follows when `/split-orders` is invoked.

- [ ] **Step 1: Read the current `SKILL.md`, then replace its final section**

Replace the line:
```
Stop here. Filtering and Splitwise are future phases — not yet implemented.
```
with:
```markdown
## Filtering and splitting (v2)

4. Save the fetched+merged `NormalizedOrder[]` to a temp JSON file, e.g.
   `/tmp/split-orders-run.json`.
5. Check for unmarked items:
   `npx tsx src/review-cli.ts --orders /tmp/split-orders-run.json --rules rules.json`
   If it prints any items, show them to the user grouped by category and ask
   personal-or-shared for each. Write the answers as
   `[{ "name": "...", "shared": true|false }, ...]` to a temp file and run:
   `npx tsx src/review-cli.ts --apply <answers-path> --rules rules.json`
6. Compute the split for each order (import `computeSplit` from `src/split.ts`
   with the orders and `loadRules('rules.json')`); drop any `null` results
   (nothing shared in that order).
7. Ensure `config.json` exists (copy `config.example.json` and ask the user to
   fill in `splitwiseApiKey` — from https://dev.splitwise.com — and
   `splitwiseGroupName` if it doesn't). Read it, then call `findGroup` from
   `src/splitwise.ts` with the configured group name.
8. Show a full preview: for every `SplitResult`, print order id, date, shared
   items, and `splitAmount`. Flag any order whose original `reconcileCharges`
   check failed. Ask for **one confirmation** before posting anything.
9. On confirmation, call `createExpense` for each `SplitResult` in order,
   description `"<source> order <date> — <orderId>"`. If any call fails, stop
   and report exactly which orders posted (with their new expense ids) and
   which did not.
```

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "docs: document v2 filter+split flow in SKILL.md"
```

---

## Self-Review

**Spec coverage:**
- Item review (dedupe, keyword-guess, correctable, persisted) → Task 1 (`categorize.ts`) + Task 4 (`review-cli.ts`). ✅
- Split calculation formula (fully-shared fees, prorated discount, no-rule = personal, null when nothing shared) → Task 2 (`split.ts`), tests assert the exact formula from the spec. ✅
- Splitwise group resolution (exact case-insensitive, 0/>1 = error) and equal-split expense creation → Task 3 (`splitwise.ts`). ✅
- Config storage (`config.json` gitignored, `config.example.json` template) → Task 5. ✅
- `rules.json` gitignored → Task 5. ✅
- Full preview + single confirmation before posting; partial-failure reporting → Task 6 (`SKILL.md` orchestration, since this is a conversational/interactive step, not a pure function — matches how v1's CLI/skill split responsibilities). ✅
- No live Splitwise calls in automated tests → Task 3 uses mocked `fetch`. ✅
- Out-of-scope items (per-item assignment to a subset, un-posting, multi-currency, auto-recategorization) — correctly excluded from all tasks. ✅

**Placeholder scan:** No TBD/TODO. Task 2's Step 2 note about adjusting a floating-point assertion is a legitimate TDD instruction (run first, observe actual behavior, fix to match) — not a deferred requirement, since the formula and expected values are fully specified.

**Type consistency:** `Rules`/`Rule`/`Category` defined in Task 1, consumed unchanged by `split.ts` (Task 2) and `review-cli.ts` (Task 4). `SplitResult` defined in Task 2, referenced by name in Task 6's orchestration text. `SplitwiseGroup` defined in Task 3, consumed by Task 6's orchestration. `dedupeItems`/`loadRules`/`saveRules`/`guessCategory` signatures match between Task 1's definition and Task 4's usage.
