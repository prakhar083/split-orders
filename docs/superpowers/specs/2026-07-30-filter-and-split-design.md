# Filter + Split Phase (v2) — Design Spec

**Date:** 2026-07-30
**Project:** `split-orders` (Claude Code skill)
**Phase:** v2 — item review, split calculation, Splitwise posting

## Overview

This builds on the v1 fetch layer (`docs/superpowers/specs/2026-07-06-order-fetch-layer-design.md`),
which produces `NormalizedOrder[]` from Zepto (official MCP, live-verified) and
Amazon Now (Playwright, parsing verified against real data). v2 adds the parts
needed to actually split a month of orders with flatmates: review which items are
personal vs shared, compute each order's split amount, and post equal-split
expenses to Splitwise.

Three new stages, each independently testable:
1. **Item Review** — dedupe items across a month, categorize, mark personal/shared, persist as rules.
2. **Split Calculation** — pure function turning an order + rules into a split amount.
3. **Splitwise Posting** — preview all computed expenses, confirm once, post via the official API.

## Decisions from brainstorming

- Rules match on **item name** (exact string key into a rules map — no fuzzy/keyword matching at apply time).
- Category is **auto-guessed via a keyword map**, correctable by the user in the review list.
- Decisions **persist** in `rules.json` — future runs only ask about genuinely new item names.
- Split method: **equal split of shared-items total, per order** (one Splitwise expense per order, not per month).
- Fees (delivery, packaging/handling, taxes, tip) are **always fully shared** — added to the split amount in full regardless of how much of the order was personal.
- Discount is **prorated by the shared-item share** of the order's item subtotal.
- Splitwise target: **an existing group**, resolved by name via the official API.
- Posting requires **one confirmation after a full preview** of every order's computed expense, then all post in that run.
- Config (Splitwise group name, API token) lives in a **local `config.json`** (gitignored), with a committed `config.example.json` template.

## Components

```
split-orders/
├── src/
│   ├── categorize.ts   # keyword→category guess; Rules load/save (rules.json)
│   ├── split.ts        # pure computeSplit(order, rules) -> SplitResult | null
│   ├── splitwise.ts    # official REST API client: findGroup, createExpense
│   └── review-cli.ts   # dedupe+group items across orders for the review step
├── config.example.json # template: { "splitwiseApiKey": "", "splitwiseGroupName": "" }
├── config.json          # gitignored — real token + group name
├── rules.json            # gitignored — { "<item name>": { "category": "...", "shared": true|false } }
└── SKILL.md              # updated to describe the full fetch → review → confirm → post flow
```

### `categorize.ts`
```ts
type Category = 'grocery' | 'personal-hygiene' | 'tobacco-alcohol' | 'household' | 'other';
interface Rule { category: Category; shared: boolean }
type Rules = Record<string, Rule>; // keyed by exact item name

function guessCategory(itemName: string): Category;   // keyword map, e.g. "cigarette"|"tobacco" -> 'tobacco-alcohol'
function loadRules(path: string): Rules;               // {} if file doesn't exist
function saveRules(path: string, rules: Rules): void;
function dedupeItems(orders: NormalizedOrder[]): { name: string; category: Category }[];
  // unique item names across all orders, each tagged with guessCategory() unless
  // already present in existing rules (in which case its saved category wins)
```
The skill uses `dedupeItems` + existing `rules.json` to show the user only items
with no saved rule yet, grouped by category, and asks personal-or-shared for each.
New answers are merged into `rules.json` via `saveRules`.

### `split.ts`
```ts
interface SplitResult {
  orderId: string;
  source: NormalizedOrder['source'];
  placedAt: string;
  sharedItems: OrderItem[];
  personalItems: OrderItem[];
  splitAmount: number;   // what the group owes in total for this order
  share: number;         // sharedSubtotal / totalSubtotal, for display
}

function computeSplit(order: NormalizedOrder, rules: Rules): SplitResult | null;
```
Logic (pure, no I/O):
```
sharedSubtotal = sum(lineTotal of items where rules[name]?.shared === true)
totalSubtotal  = order.charges.subtotal
if (sharedSubtotal === 0) return null   // nothing to split for this order

share = sharedSubtotal / totalSubtotal
fees  = (deliveryFee ?? 0) + (packagingFee ?? 0) + (taxes ?? 0) + (tip ?? 0)   // fully shared
proratedDiscount = (discount ?? 0) * share
splitAmount = round2(sharedSubtotal + fees - proratedDiscount)
```
An item with no matching rule is treated as **not shared** (conservative default —
never auto-split something the user hasn't reviewed).

### `splitwise.ts`
Thin wrapper over `https://secure.splitwise.com/api/v3.0`, using the API key from
`config.json`.
```ts
interface SplitwiseGroup { id: number; name: string; members: { id: number }[] }

async function findGroup(apiKey: string, name: string): Promise<SplitwiseGroup>;
  // GET /get_groups, exact case-insensitive name match (no partial/substring
  // matching); throws if 0 or >1 groups match exactly

async function createExpense(apiKey: string, group: SplitwiseGroup, opts: {
  description: string; amount: number; date: string; // ISO
}): Promise<{ id: number }>;
  // POST /create_expense — equal split (split_equally=true) among group.members
```
No retries/backoff — a failed call throws and is reported per-order (see Error handling).

### `review-cli.ts`
A small script the skill shells out to for the review step:
```
review-items --orders <path-to-NormalizedOrder[].json> --rules rules.json
```
Prints the grouped-by-category, unmarked-only item list as JSON for the skill to
present to the user; a second invocation `--apply <answers.json>` merges the
user's personal/shared answers into `rules.json`.

## Data flow (full run)

1. Skill fetches orders (v1 fetch layer, unchanged) → `NormalizedOrder[]`.
2. Skill calls `dedupeItems` against `rules.json`; if any item has no saved rule,
   presents the grouped list and asks personal/shared per item; saves answers via
   `saveRules`.
3. Skill runs `computeSplit` per order → drops `null`s (nothing shared) → `SplitResult[]`.
4. Skill reads `config.json`, resolves the Splitwise group via `findGroup`.
5. Skill shows a **full preview table**: order, date, shared items, split amount,
   per-person share — and asks for one confirmation.
6. On confirmation, skill calls `createExpense` for each `SplitResult` in order.

## Error handling

- Missing/invalid `config.json` (no API key or group name) → fail before any
  Splitwise call, with a clear message pointing at `config.example.json`.
- `findGroup` matching 0 or >1 groups → fail loudly, list the candidate names found.
- `computeSplit` never throws — a `reconcileCharges` mismatch on the source order
  is surfaced as a warning annotation in the preview, not a blocker; the user
  decides whether to post it.
- If `createExpense` fails partway through the confirmed batch, stop posting
  further orders and report exactly which orders succeeded (with their new
  Splitwise expense ids) and which did not — never a silent partial state.
- An item name with no rule is never auto-shared (see `split.ts` default above) —
  under-splitting (asking again) is preferred over accidentally billing flatmates
  for a personal item.

## Testing (TDD)

- `categorize.test.ts` — `guessCategory` keyword coverage; `dedupeItems` correctly
  unions items across multiple orders without duplicates, and prefers an existing
  rule's category over a fresh guess.
- `split.test.ts` — `computeSplit` against fixtures: all-shared order, all-personal
  order (→ null), mixed order (verifies prorated discount + fully-shared fees
  match the formula above), item with no rule (treated as personal).
- `splitwise.test.ts` — `findGroup`/`createExpense` tested against mocked HTTP
  responses (success, 0-match, multi-match, API error) — no live Splitwise calls
  in the automated suite.
- Live posting is validated by a **manual smoke test** with a real (small/test)
  Splitwise expense, the same pattern used for v1's live Zepto/Amazon checks.

## Out of scope

- Per-item assignment to a subset of flatmates (decided: always the full group, equally).
- Un-posting / editing a Splitwise expense after creation.
- Multi-currency (decided: `INR` only, matching v1).
- Automatic re-categorization if a keyword guess turns out wrong after the fact —
  the user corrects it once in the review step and that becomes the standing rule.
