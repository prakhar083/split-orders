# Order Fetch Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data-fetching layer of the `split-orders` skill — pull a windowed set of recent orders from Zepto (official MCP), Amazon.in, and Blinkit (local Playwright), and normalize them all into one `NormalizedOrder[]`.

**Architecture:** A Claude Code skill (`SKILL.md`) orchestrates. Zepto orders come from the official Zepto MCP tool; its payload is mapped by a pure TS mapper. Amazon/Blinkit orders are scraped by local Playwright fetchers that reuse a persisted login session. Each source produces the same `NormalizedOrder` shape via pure, fixture-tested parse functions. A small CLI merges the scraper output and (via stdin) maps Zepto payloads.

**Tech Stack:** Node 20+, TypeScript (ESM), Playwright (chromium), cheerio (HTML parsing), Vitest (tests), tsx (run TS directly, no build step).

## Global Constraints

- Node **20+**, TypeScript **strict**, ESM (`"type": "module"`); run TS via `tsx`, no build step.
- All money values are **numbers in INR rupees** (not paise). `currency` is always `'INR'`.
- Charge identity: `grandTotal = subtotal + taxes + deliveryFee + packagingFee + tip − discount`, where `discount` is a **positive** number. Every order must reconcile within **±1 INR** or be flagged.
- **Capture every charge line** now (fees/taxes/discounts) — never re-fetch later.
- **Never silently drop items.** Parse failure fails loudly and saves a screenshot + page HTML to the scratchpad.
- Persisted browser profiles live in `.sessions/<source>/` and are **gitignored**.
- **Zepto is accessed only via its official MCP** (`https://mcp.zepto.co.in/mcp`). Amazon/Blinkit are scraped from the user's own accounts (personal use; risks accepted).
- v1 stops at normalized fetched orders. **No filtering, no Splitwise.**

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` — project scaffold.
- `src/schema.ts` — `NormalizedOrder` types, `validateOrder`, `reconcileCharges`.
- `src/util.ts` — `parseINR`, `applyWindow`.
- `src/zepto.ts` — `mapZeptoOrders` (MCP payload → orders).
- `src/session.ts` — persisted-profile browser launcher + `isLoggedOut`.
- `src/amazon.ts` — `parseAmazonOrderList`, `parseAmazonOrderDetail`, `fetchAmazonOrders`.
- `src/blinkit.ts` — `parseBlinkitOrderList`, `parseBlinkitOrderDetail`, `fetchBlinkitOrders`.
- `src/cli.ts` — arg parsing, scraper orchestration, `--map-zepto` stdin mode.
- `SKILL.md` — skill orchestration + setup instructions.
- `test/fixtures/*` — saved HTML + sample MCP payload.
- `test/*.test.ts` — unit tests.

> **Execution note on scrapers:** The Amazon/Blinkit fixtures in this plan are *representative* synthetic HTML so tests are complete and green. During execution, capture a **real** order-detail page (see each fetcher task), replace the fixture, and adjust selectors and the fixture **together** so the test stays green. The Zepto payload fixture is likewise representative until the live MCP output is inspected.

---

### Task 1: Project scaffold + schema + utilities

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/schema.ts`, `src/util.ts`
- Test: `test/schema.test.ts`, `test/util.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Source = 'zepto' | 'amazon' | 'blinkit'`
  - `interface OrderItem { name: string; quantity: number; unitPrice?: number; lineTotal: number }`
  - `interface Charges { subtotal: number; taxes?: number; deliveryFee?: number; packagingFee?: number; discount?: number; tip?: number }`
  - `interface NormalizedOrder { source: Source; orderId: string; placedAt: string; items: OrderItem[]; charges: Charges; grandTotal: number; currency: 'INR'; raw?: unknown }`
  - `validateOrder(o: unknown): string[]` — returns list of problems (empty = valid)
  - `reconcileCharges(o: NormalizedOrder): { ok: boolean; expected: number; diff: number }`
  - `parseINR(text: string): number`
  - `applyWindow<T extends { placedAt: string }>(entries: T[], opts: { since?: string; limit?: number }): T[]`

- [ ] **Step 1: Initialize project + git**

```bash
cd split-orders
git init
npm init -y
npm pkg set type=module
npm install -D typescript tsx vitest @types/node
npm install playwright cheerio
npx playwright install chromium
npm pkg set scripts.test="vitest run"
```

- [ ] **Step 2: Write config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

`.gitignore`:
```
node_modules/
dist/
.sessions/
*.log
```

- [ ] **Step 3: Write the failing tests**

`test/util.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseINR, applyWindow } from '../src/util.js';

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
```

`test/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateOrder, reconcileCharges, type NormalizedOrder } from '../src/schema.js';

const good: NormalizedOrder = {
  source: 'amazon', orderId: 'X1', placedAt: '2026-07-03T00:00:00.000Z',
  items: [{ name: 'Salt', quantity: 2, unitPrice: 28, lineTotal: 56 }],
  charges: { subtotal: 56, deliveryFee: 40 }, grandTotal: 96, currency: 'INR',
};

describe('validateOrder', () => {
  it('accepts a well-formed order', () => {
    expect(validateOrder(good)).toEqual([]);
  });
  it('flags missing/invalid fields', () => {
    const bad = { ...good, orderId: '', items: [] };
    const errs = validateOrder(bad);
    expect(errs.some(e => e.includes('orderId'))).toBe(true);
    expect(errs.some(e => e.includes('items'))).toBe(true);
  });
});

describe('reconcileCharges', () => {
  it('accepts totals within ±1 INR', () => {
    expect(reconcileCharges(good).ok).toBe(true);
  });
  it('flags a mismatch and reports the diff', () => {
    const r = reconcileCharges({ ...good, grandTotal: 120 });
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(24);
  });
  it('treats discount as a positive reduction', () => {
    const withDisc: NormalizedOrder = {
      ...good, charges: { subtotal: 56, deliveryFee: 40, discount: 16 }, grandTotal: 80,
    };
    expect(reconcileCharges(withDisc).ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot import `../src/util.js` / `../src/schema.js` (modules not found).

- [ ] **Step 5: Implement `src/util.ts`**

```ts
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
```

- [ ] **Step 6: Implement `src/schema.ts`**

```ts
export type Source = 'zepto' | 'amazon' | 'blinkit';

export interface OrderItem {
  name: string;
  quantity: number;
  unitPrice?: number;
  lineTotal: number;
}

export interface Charges {
  subtotal: number;
  taxes?: number;
  deliveryFee?: number;
  packagingFee?: number;
  discount?: number;
  tip?: number;
}

export interface NormalizedOrder {
  source: Source;
  orderId: string;
  placedAt: string; // ISO 8601
  items: OrderItem[];
  charges: Charges;
  grandTotal: number;
  currency: 'INR';
  raw?: unknown;
}

export function validateOrder(o: unknown): string[] {
  const errs: string[] = [];
  const order = o as Partial<NormalizedOrder>;
  if (!order || typeof order !== 'object') return ['not an object'];
  if (!['zepto', 'amazon', 'blinkit'].includes(order.source as string)) errs.push('invalid source');
  if (!order.orderId) errs.push('missing orderId');
  if (!order.placedAt || Number.isNaN(new Date(order.placedAt).getTime())) errs.push('invalid placedAt');
  if (!Array.isArray(order.items) || order.items.length === 0) errs.push('missing items');
  if (order.currency !== 'INR') errs.push('currency must be INR');
  if (typeof order.grandTotal !== 'number') errs.push('missing grandTotal');
  if (!order.charges || typeof order.charges.subtotal !== 'number') errs.push('missing charges.subtotal');
  return errs;
}

export function reconcileCharges(o: NormalizedOrder): { ok: boolean; expected: number; diff: number } {
  const c = o.charges;
  const expected =
    c.subtotal + (c.taxes ?? 0) + (c.deliveryFee ?? 0) + (c.packagingFee ?? 0) + (c.tip ?? 0) - (c.discount ?? 0);
  const diff = Math.round((o.grandTotal - expected) * 100) / 100;
  return { ok: Math.abs(diff) <= 1, expected, diff };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests in `schema.test.ts` and `util.test.ts` green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: project scaffold, NormalizedOrder schema, and shared utils"
```

---

### Task 2: Zepto MCP payload mapper

**Files:**
- Create: `src/zepto.ts`
- Test: `test/zepto.test.ts`, `test/fixtures/zepto-payload.json`

**Interfaces:**
- Consumes: `NormalizedOrder`, `OrderItem`, `Charges` from `src/schema.ts`.
- Produces: `mapZeptoOrders(payload: unknown): NormalizedOrder[]`

- [ ] **Step 1: Create the representative fixture**

`test/fixtures/zepto-payload.json`:
```json
{
  "orders": [
    {
      "order_id": "ZP-9001",
      "placed_at": "2026-07-04T08:30:00.000Z",
      "items": [
        { "name": "Amul Milk 500ml", "quantity": 2, "price": 27 },
        { "name": "Brown Bread", "quantity": 1, "price": 45 }
      ],
      "bill": { "item_total": 99, "tax": 5, "delivery_charge": 15, "discount": 19 },
      "grand_total": 100
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`test/zepto.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapZeptoOrders } from '../src/zepto.js';
import { reconcileCharges } from '../src/schema.js';

const payload = JSON.parse(readFileSync(new URL('./fixtures/zepto-payload.json', import.meta.url), 'utf8'));

describe('mapZeptoOrders', () => {
  it('maps the MCP payload to NormalizedOrder[]', () => {
    const orders = mapZeptoOrders(payload);
    expect(orders).toHaveLength(1);
    const o = orders[0];
    expect(o.source).toBe('zepto');
    expect(o.orderId).toBe('ZP-9001');
    expect(o.items).toHaveLength(2);
    expect(o.items[0]).toMatchObject({ name: 'Amul Milk 500ml', quantity: 2, unitPrice: 27, lineTotal: 54 });
    expect(o.charges).toMatchObject({ subtotal: 99, taxes: 5, deliveryFee: 15, discount: 19 });
    expect(o.grandTotal).toBe(100);
  });
  it('produces reconciling totals', () => {
    expect(reconcileCharges(mapZeptoOrders(payload)[0]).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/zepto.test.ts`
Expected: FAIL — cannot import `../src/zepto.js`.

- [ ] **Step 4: Implement `src/zepto.ts`**

```ts
import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

interface ZeptoItem { name: string; quantity: number; price: number }
interface ZeptoBill { item_total: number; tax?: number; delivery_charge?: number; packaging_charge?: number; discount?: number }
interface ZeptoOrder { order_id: string; placed_at: string; items: ZeptoItem[]; bill: ZeptoBill; grand_total: number }

export function mapZeptoOrders(payload: unknown): NormalizedOrder[] {
  const orders = (payload as { orders?: ZeptoOrder[] })?.orders ?? [];
  return orders.map((o): NormalizedOrder => {
    const items: OrderItem[] = o.items.map(i => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.price,
      lineTotal: +(i.price * i.quantity).toFixed(2),
    }));
    const charges: Charges = { subtotal: o.bill.item_total };
    if (o.bill.tax != null) charges.taxes = o.bill.tax;
    if (o.bill.delivery_charge != null) charges.deliveryFee = o.bill.delivery_charge;
    if (o.bill.packaging_charge != null) charges.packagingFee = o.bill.packaging_charge;
    if (o.bill.discount != null) charges.discount = o.bill.discount;
    return {
      source: 'zepto',
      orderId: o.order_id,
      placedAt: new Date(o.placed_at).toISOString(),
      items,
      charges,
      grandTotal: o.grand_total,
      currency: 'INR',
      raw: o,
    };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/zepto.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: map Zepto MCP payload to NormalizedOrder"
```

> **Execution note:** After adding the Zepto MCP live (Task 8), call its order-history tool once, save the real response to `test/fixtures/zepto-payload.json`, and adjust the `Zepto*` interfaces + mapping to the real field names. Keep the test green.

---

### Task 3: Session manager

**Files:**
- Create: `src/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `playwright`).
- Produces:
  - `interface LoginConfig { loginUrlPattern: RegExp; authMarker: string }`
  - `sessionDir(source: string): string`
  - `isLoggedOut(url: string, authMarkerPresent: boolean, cfg: LoginConfig): boolean`
  - `openSession(source: string, startUrl: string, cfg: LoginConfig, opts: { headless: boolean }): Promise<{ context: BrowserContext; page: Page }>`

- [ ] **Step 1: Write the failing test**

`test/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { sessionDir, isLoggedOut, type LoginConfig } from '../src/session.js';

const cfg: LoginConfig = { loginUrlPattern: /\/ap\/signin|\/login/, authMarker: '#nav-user' };

describe('sessionDir', () => {
  it('points into .sessions/<source>', () => {
    expect(sessionDir('amazon').endsWith('/.sessions/amazon')).toBe(true);
  });
});

describe('isLoggedOut', () => {
  it('is true on a login URL', () => {
    expect(isLoggedOut('https://www.amazon.in/ap/signin?x=1', true, cfg)).toBe(true);
  });
  it('is true when the auth marker is absent', () => {
    expect(isLoggedOut('https://www.amazon.in/gp/css/order-history', false, cfg)).toBe(true);
  });
  it('is false when on a normal page with the auth marker present', () => {
    expect(isLoggedOut('https://www.amazon.in/gp/css/order-history', true, cfg)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — cannot import `../src/session.js`.

- [ ] **Step 3: Implement `src/session.ts`**

```ts
import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface LoginConfig {
  loginUrlPattern: RegExp;
  authMarker: string; // selector present only when logged in
}

export function sessionDir(source: string): string {
  return path.join(ROOT, '.sessions', source);
}

export function isLoggedOut(url: string, authMarkerPresent: boolean, cfg: LoginConfig): boolean {
  return cfg.loginUrlPattern.test(url) || !authMarkerPresent;
}

async function launch(source: string, headless: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(sessionDir(source), { headless });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

export async function openSession(
  source: string,
  startUrl: string,
  cfg: LoginConfig,
  opts: { headless: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  let { context, page } = await launch(source, opts.headless);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  const markerPresent = (await page.locator(cfg.authMarker).count()) > 0;

  if (isLoggedOut(page.url(), markerPresent, cfg)) {
    // Need a human login. Relaunch headed and wait for the auth marker to appear.
    await context.close();
    ({ context, page } = await launch(source, false));
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    console.error(`[${source}] Please log in (and enter OTP) in the opened browser window…`);
    await page.waitForSelector(cfg.authMarker, { timeout: 300_000 });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  }
  return { context, page };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session.test.ts`
Expected: PASS (pure functions `sessionDir` / `isLoggedOut`; `openSession` is exercised later by manual smoke tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: persisted-profile session manager with logged-out detection"
```

---

### Task 4: Amazon fetcher

**Files:**
- Create: `src/amazon.ts`
- Test: `test/amazon.test.ts`, `test/fixtures/amazon-list.html`, `test/fixtures/amazon-detail.html`

**Interfaces:**
- Consumes: `parseINR` (util), `NormalizedOrder`/`OrderItem`/`Charges` (schema), `openSession`/`LoginConfig` (session), `applyWindow` (util).
- Produces:
  - `interface OrderRef { orderId: string; detailUrl: string; placedAt: string }`
  - `parseAmazonOrderList(html: string): OrderRef[]`
  - `parseAmazonOrderDetail(html: string): NormalizedOrder`
  - `fetchAmazonOrders(opts: { since?: string; limit?: number }): Promise<NormalizedOrder[]>`

- [ ] **Step 1: Create representative fixtures**

`test/fixtures/amazon-list.html`:
```html
<div id="ordersContainer">
  <div class="order-card">
    <span class="order-date">Ordered on 4 July 2026</span>
    <bdi class="order-number">407-1111111-1111111</bdi>
    <a class="a-link-normal view-order" href="/gp/css/order-details?orderID=407-1111111-1111111">View order details</a>
  </div>
  <div class="order-card">
    <span class="order-date">Ordered on 20 June 2026</span>
    <bdi class="order-number">407-2222222-2222222</bdi>
    <a class="a-link-normal view-order" href="/gp/css/order-details?orderID=407-2222222-2222222">View order details</a>
  </div>
</div>
```

`test/fixtures/amazon-detail.html`:
```html
<div id="orderDetails">
  <span class="order-date-invoice-item">Ordered on 4 July 2026</span>
  <bdi class="order-number">407-1111111-1111111</bdi>
  <div class="yohtmlc-item">
    <a class="a-link-normal">Tata Salt 1kg</a>
    <span class="item-quantity">Qty: 2</span>
    <span class="a-price"><span class="a-offscreen">₹28.00</span></span>
  </div>
  <table class="od-summary">
    <tr><td>Item(s) Subtotal:</td><td class="a-text-right">₹56.00</td></tr>
    <tr><td>Delivery:</td><td class="a-text-right">₹40.00</td></tr>
    <tr><td>Total:</td><td class="a-text-right">₹96.00</td></tr>
  </table>
</div>
```

- [ ] **Step 2: Write the failing tests**

`test/amazon.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAmazonOrderList, parseAmazonOrderDetail } from '../src/amazon.js';
import { reconcileCharges } from '../src/schema.js';

const list = readFileSync(new URL('./fixtures/amazon-list.html', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./fixtures/amazon-detail.html', import.meta.url), 'utf8');

describe('parseAmazonOrderList', () => {
  it('extracts order refs with id, url, and ISO date', () => {
    const refs = parseAmazonOrderList(list);
    expect(refs).toHaveLength(2);
    expect(refs[0].orderId).toBe('407-1111111-1111111');
    expect(refs[0].detailUrl).toContain('/gp/css/order-details?orderID=407-1111111-1111111');
    expect(refs[0].placedAt.startsWith('2026-07-04')).toBe(true);
  });
});

describe('parseAmazonOrderDetail', () => {
  it('extracts items and charges into a reconciling order', () => {
    const o = parseAmazonOrderDetail(detail);
    expect(o.source).toBe('amazon');
    expect(o.orderId).toBe('407-1111111-1111111');
    expect(o.items[0]).toMatchObject({ name: 'Tata Salt 1kg', quantity: 2, unitPrice: 28, lineTotal: 56 });
    expect(o.charges).toMatchObject({ subtotal: 56, deliveryFee: 40 });
    expect(o.grandTotal).toBe(96);
    expect(reconcileCharges(o).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/amazon.test.ts`
Expected: FAIL — cannot import `../src/amazon.js`.

- [ ] **Step 4: Implement `src/amazon.ts`**

```ts
import * as cheerio from 'cheerio';
import { parseINR, applyWindow } from './util.js';
import { openSession, type LoginConfig } from './session.js';
import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

export interface OrderRef { orderId: string; detailUrl: string; placedAt: string }

const AMAZON_LOGIN: LoginConfig = { loginUrlPattern: /\/ap\/signin/, authMarker: '#nav-link-accountList, #nav-user' };
const ORIGIN = 'https://www.amazon.in';

function isoFromOrderedOn(text: string): string {
  const m = text.replace(/Ordered on/i, '').trim();
  return new Date(m).toISOString();
}

export function parseAmazonOrderList(html: string): OrderRef[] {
  const $ = cheerio.load(html);
  const refs: OrderRef[] = [];
  $('.order-card').each((_, el) => {
    const orderId = $(el).find('.order-number').first().text().trim();
    const href = $(el).find('a.view-order').first().attr('href') ?? '';
    const placedAt = isoFromOrderedOn($(el).find('.order-date').first().text());
    if (orderId) refs.push({ orderId, detailUrl: href.startsWith('http') ? href : ORIGIN + href, placedAt });
  });
  return refs;
}

export function parseAmazonOrderDetail(html: string): NormalizedOrder {
  const $ = cheerio.load(html);
  const orderId = $('.order-number').first().text().trim();
  const placedAt = isoFromOrderedOn($('.order-date-invoice-item').first().text());

  const items: OrderItem[] = [];
  $('.yohtmlc-item').each((_, el) => {
    const name = $(el).find('a.a-link-normal').first().text().trim();
    const quantity = parseInt($(el).find('.item-quantity').first().text().replace(/\D/g, ''), 10) || 1;
    const unitPrice = parseINR($(el).find('.a-price .a-offscreen').first().text());
    items.push({ name, quantity, unitPrice, lineTotal: +(unitPrice * quantity).toFixed(2) });
  });

  const summary = (label: string): number | undefined => {
    let val: number | undefined;
    $('.od-summary tr').each((_, row) => {
      const cells = $(row).find('td');
      if ($(cells[0]).text().trim().toLowerCase().startsWith(label.toLowerCase())) val = parseINR($(cells[1]).text());
    });
    return val;
  };

  const subtotal = summary('Item(s) Subtotal') ?? 0;
  const charges: Charges = { subtotal };
  const delivery = summary('Delivery');
  if (delivery != null) charges.deliveryFee = delivery;
  const promo = summary('Promotion');
  if (promo != null) charges.discount = Math.abs(promo);
  const grandTotal = summary('Total') ?? subtotal;

  if (items.length === 0) throw new Error(`Amazon order ${orderId}: no items parsed`);
  return { source: 'amazon', orderId, placedAt, items, charges, grandTotal, currency: 'INR', raw: { html } };
}

export async function fetchAmazonOrders(opts: { since?: string; limit?: number }): Promise<NormalizedOrder[]> {
  const { context, page } = await openSession('amazon', `${ORIGIN}/gp/css/order-history`, AMAZON_LOGIN, { headless: true });
  try {
    const refs = applyWindow(parseAmazonOrderList(await page.content()), opts);
    const orders: NormalizedOrder[] = [];
    for (const ref of refs) {
      await page.goto(ref.detailUrl, { waitUntil: 'domcontentloaded' });
      orders.push(parseAmazonOrderDetail(await page.content()));
    }
    return orders;
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/amazon.test.ts`
Expected: PASS (parse functions). `fetchAmazonOrders` is validated by the manual smoke test below.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Amazon order list/detail parsers and Playwright fetcher"
```

> **Execution note (real DOM):** Run `npx tsx -e "import('./src/session.js').then(m=>m.openSession('amazon','https://www.amazon.in/gp/css/order-history',{loginUrlPattern:/\/ap\/signin/,authMarker:'#nav-link-accountList'},{headless:false}))"`, log in, then save a real order-history page and a real order-detail page into the two fixtures. Update selectors so both tests stay green. Then smoke-test: `npx tsx src/cli.ts --sources amazon --limit 1`.

---

### Task 5: Blinkit fetcher

**Files:**
- Create: `src/blinkit.ts`
- Test: `test/blinkit.test.ts`, `test/fixtures/blinkit-list.html`, `test/fixtures/blinkit-detail.html`

**Interfaces:**
- Consumes: `parseINR`/`applyWindow` (util), `NormalizedOrder`/`OrderItem`/`Charges` (schema), `openSession`/`LoginConfig` (session), `OrderRef` (redeclared locally — Blinkit owns its own copy to stay independent of amazon.ts).
- Produces:
  - `parseBlinkitOrderList(html: string): { orderId: string; detailUrl: string; placedAt: string }[]`
  - `parseBlinkitOrderDetail(html: string): NormalizedOrder`
  - `fetchBlinkitOrders(opts: { since?: string; limit?: number }): Promise<NormalizedOrder[]>`

- [ ] **Step 1: Create representative fixtures**

`test/fixtures/blinkit-list.html`:
```html
<div class="orders">
  <a class="order-row" href="/account/orders/BK-5001" data-placed-at="2026-07-05T19:00:00.000Z">
    <span class="order-id">BK-5001</span>
  </a>
  <a class="order-row" href="/account/orders/BK-4000" data-placed-at="2026-06-15T19:00:00.000Z">
    <span class="order-id">BK-4000</span>
  </a>
</div>
```

`test/fixtures/blinkit-detail.html`:
```html
<div class="order-detail" data-order-id="BK-5001" data-placed-at="2026-07-05T19:00:00.000Z">
  <div class="product-row">
    <span class="product-name">Onion 1kg</span>
    <span class="product-qty">x3</span>
    <span class="product-price">₹30</span>
  </div>
  <div class="bill">
    <div class="bill-row"><span>Item total</span><span>₹90</span></div>
    <div class="bill-row"><span>Handling charge</span><span>₹5</span></div>
    <div class="bill-row"><span>Delivery charge</span><span>₹25</span></div>
    <div class="bill-row grand"><span>Grand total</span><span>₹120</span></div>
  </div>
</div>
```

- [ ] **Step 2: Write the failing tests**

`test/blinkit.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBlinkitOrderList, parseBlinkitOrderDetail } from '../src/blinkit.js';
import { reconcileCharges } from '../src/schema.js';

const list = readFileSync(new URL('./fixtures/blinkit-list.html', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./fixtures/blinkit-detail.html', import.meta.url), 'utf8');

describe('parseBlinkitOrderList', () => {
  it('extracts order refs', () => {
    const refs = parseBlinkitOrderList(list);
    expect(refs).toHaveLength(2);
    expect(refs[0].orderId).toBe('BK-5001');
    expect(refs[0].detailUrl).toContain('/account/orders/BK-5001');
    expect(refs[0].placedAt.startsWith('2026-07-05')).toBe(true);
  });
});

describe('parseBlinkitOrderDetail', () => {
  it('extracts items and charges into a reconciling order', () => {
    const o = parseBlinkitOrderDetail(detail);
    expect(o.source).toBe('blinkit');
    expect(o.orderId).toBe('BK-5001');
    expect(o.items[0]).toMatchObject({ name: 'Onion 1kg', quantity: 3, unitPrice: 30, lineTotal: 90 });
    expect(o.charges).toMatchObject({ subtotal: 90, packagingFee: 5, deliveryFee: 25 });
    expect(o.grandTotal).toBe(120);
    expect(reconcileCharges(o).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/blinkit.test.ts`
Expected: FAIL — cannot import `../src/blinkit.js`.

- [ ] **Step 4: Implement `src/blinkit.ts`**

```ts
import * as cheerio from 'cheerio';
import { parseINR, applyWindow } from './util.js';
import { openSession, type LoginConfig } from './session.js';
import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

interface OrderRef { orderId: string; detailUrl: string; placedAt: string }

const BLINKIT_LOGIN: LoginConfig = { loginUrlPattern: /\/login|\/auth/, authMarker: '[data-testid="account-menu"], .account-menu' };
const ORIGIN = 'https://blinkit.com';

export function parseBlinkitOrderList(html: string): OrderRef[] {
  const $ = cheerio.load(html);
  const refs: OrderRef[] = [];
  $('.order-row').each((_, el) => {
    const orderId = $(el).find('.order-id').first().text().trim();
    const href = $(el).attr('href') ?? '';
    const placedAt = new Date($(el).attr('data-placed-at') ?? '').toISOString();
    if (orderId) refs.push({ orderId, detailUrl: href.startsWith('http') ? href : ORIGIN + href, placedAt });
  });
  return refs;
}

export function parseBlinkitOrderDetail(html: string): NormalizedOrder {
  const $ = cheerio.load(html);
  const root = $('.order-detail').first();
  const orderId = root.attr('data-order-id')?.trim() ?? '';
  const placedAt = new Date(root.attr('data-placed-at') ?? '').toISOString();

  const items: OrderItem[] = [];
  $('.product-row').each((_, el) => {
    const name = $(el).find('.product-name').first().text().trim();
    const quantity = parseInt($(el).find('.product-qty').first().text().replace(/\D/g, ''), 10) || 1;
    const unitPrice = parseINR($(el).find('.product-price').first().text());
    items.push({ name, quantity, unitPrice, lineTotal: +(unitPrice * quantity).toFixed(2) });
  });

  const bill = (label: string): number | undefined => {
    let val: number | undefined;
    $('.bill .bill-row').each((_, row) => {
      const cells = $(row).find('span');
      if ($(cells[0]).text().trim().toLowerCase().startsWith(label.toLowerCase())) val = parseINR($(cells[1]).text());
    });
    return val;
  };

  const subtotal = bill('Item total') ?? 0;
  const charges: Charges = { subtotal };
  const handling = bill('Handling charge');
  if (handling != null) charges.packagingFee = handling;
  const delivery = bill('Delivery charge');
  if (delivery != null) charges.deliveryFee = delivery;
  const discount = bill('Discount');
  if (discount != null) charges.discount = Math.abs(discount);
  const grandTotal = bill('Grand total') ?? subtotal;

  if (items.length === 0) throw new Error(`Blinkit order ${orderId}: no items parsed`);
  return { source: 'blinkit', orderId, placedAt, items, charges, grandTotal, currency: 'INR', raw: { html } };
}

export async function fetchBlinkitOrders(opts: { since?: string; limit?: number }): Promise<NormalizedOrder[]> {
  const { context, page } = await openSession('blinkit', `${ORIGIN}/account/orders`, BLINKIT_LOGIN, { headless: true });
  try {
    const refs = applyWindow(parseBlinkitOrderList(await page.content()), opts);
    const orders: NormalizedOrder[] = [];
    for (const ref of refs) {
      await page.goto(ref.detailUrl, { waitUntil: 'domcontentloaded' });
      orders.push(parseBlinkitOrderDetail(await page.content()));
    }
    return orders;
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/blinkit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Blinkit order list/detail parsers and Playwright fetcher"
```

> **Execution note (real DOM):** Blinkit's order pages are heavily client-rendered — after `page.goto`, you may need `await page.waitForSelector('.order-row')` (list) / `'.order-detail'` (detail) before reading `page.content()`. Capture real pages into the fixtures and adjust selectors so tests stay green, then smoke-test: `npx tsx src/cli.ts --sources blinkit --limit 1`.

---

### Task 6: CLI

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `fetchAmazonOrders` (amazon), `fetchBlinkitOrders` (blinkit), `mapZeptoOrders` (zepto).
- Produces:
  - `parseArgs(argv: string[]): { sources: string[]; since?: string; limit?: number; mapZepto: boolean }`
  - `validateWindow(a: { since?: string; limit?: number; mapZepto: boolean }): string[]`
  - a runnable entrypoint: `--sources amazon,blinkit [--since ISO] [--limit N]` scrapes; `--map-zepto` maps a Zepto MCP payload read from stdin.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseArgs, validateWindow } from '../src/cli.js';

describe('parseArgs', () => {
  it('parses sources, since, and limit', () => {
    const a = parseArgs(['--sources', 'amazon,blinkit', '--since', '2026-07-01', '--limit', '5']);
    expect(a).toEqual({ sources: ['amazon', 'blinkit'], since: '2026-07-01', limit: 5, mapZepto: false });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — cannot import `../src/cli.js`.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
import { fetchAmazonOrders } from './amazon.js';
import { fetchBlinkitOrders } from './blinkit.js';
import { mapZeptoOrders } from './zepto.js';
import type { NormalizedOrder } from './schema.js';

export function parseArgs(argv: string[]): { sources: string[]; since?: string; limit?: number; mapZepto: boolean } {
  const out: { sources: string[]; since?: string; limit?: number; mapZepto: boolean } = { sources: [], mapZepto: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map-zepto') out.mapZepto = true;
    else if (a === '--sources') out.sources = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

export function validateWindow(a: { since?: string; limit?: number; mapZepto: boolean }): string[] {
  if (a.mapZepto) return [];
  if (!a.since && a.limit == null) return ['provide at least one of --since or --limit'];
  return [];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const errs = validateWindow(args);
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(2);
  }

  if (args.mapZepto) {
    const payload = JSON.parse(await readStdin());
    process.stdout.write(JSON.stringify(mapZeptoOrders(payload), null, 2));
    return;
  }

  const orders: NormalizedOrder[] = [];
  const errors: string[] = [];
  if (args.sources.includes('amazon')) {
    try { orders.push(...(await fetchAmazonOrders(args))); }
    catch (e) { errors.push(`amazon: ${(e as Error).message}`); }
  }
  if (args.sources.includes('blinkit')) {
    try { orders.push(...(await fetchBlinkitOrders(args))); }
    catch (e) { errors.push(`blinkit: ${(e as Error).message}`); }
  }
  if (errors.length) console.error(errors.join('\n'));
  process.stdout.write(JSON.stringify(orders, null, 2));
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: CLI with scrape orchestration and --map-zepto stdin mode"
```

---

### Task 7: SKILL.md orchestration + setup docs

**Files:**
- Create: `SKILL.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `src/cli.ts` (via `npx tsx`), the Zepto MCP tool (added at runtime).
- Produces: the user-invocable skill.

- [ ] **Step 1: Write `SKILL.md`**

````markdown
---
name: split-orders
description: Fetch recent orders from Zepto (official MCP), Amazon.in, and Blinkit (local Playwright), normalized into one list. v1 = data fetching only; filtering and Splitwise come later.
---

# split-orders (v1: fetch layer)

Fetch a windowed set of recent orders from Zepto, Amazon, and Blinkit and present
them as one normalized list. **This version only fetches and shows orders.** It does
not filter or post to Splitwise yet.

## One-time setup

1. Add the official Zepto MCP:
   `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`
   Then complete the OAuth login (Indian mobile) when prompted.
2. In this project: `npm install && npx playwright install chromium`.
3. First Amazon/Blinkit run opens a browser for you to log in (incl. OTP); the
   session is saved under `.sessions/` and reused afterward.

## Running

Ask the user for the window (a `--since` date and/or a `--limit` count) and which
sources to include.

1. **Zepto** (if included): call the Zepto MCP order-history tool, then map it:
   `echo '<mcp-payload-json>' | npx tsx src/cli.ts --map-zepto`
2. **Amazon / Blinkit** (if included):
   `npx tsx src/cli.ts --sources amazon,blinkit --since <ISO> --limit <N>`
   (A visible browser opens if the saved session has expired — let the user log in.)
3. Merge the two JSON outputs and present a table: source, orderId, date, each
   item (name × qty = lineTotal), and the charge breakdown. Note any order whose
   `reconcileCharges` flagged a mismatch.

Stop here. Filtering and Splitwise are future phases.
````

- [ ] **Step 2: Write `README.md`**

```markdown
# split-orders

Fetch layer for the split-orders skill. Pulls recent orders from Zepto (official
MCP), Amazon.in, and Blinkit (local Playwright) into one `NormalizedOrder[]`.

## Setup
- `npm install && npx playwright install chromium`
- Add Zepto MCP: `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`

## Test
- `npm test`

## Usage
- Scrape: `npx tsx src/cli.ts --sources amazon,blinkit --limit 5`
- Map Zepto MCP payload: `echo '<payload>' | npx tsx src/cli.ts --map-zepto`

Amazon/Blinkit are scraped from your own accounts; sessions persist in `.sessions/`
(gitignored). See `docs/superpowers/specs/2026-07-06-order-fetch-layer-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: SKILL.md orchestration and README setup"
```

---

## Self-Review

**Spec coverage:**
- NormalizedOrder schema + reconcile → Task 1. ✅
- Zepto via official MCP + mapper → Task 2 + Task 7 (MCP add + `--map-zepto`). ✅
- Persisted-session login manager → Task 3. ✅
- Amazon Playwright fetcher + parsers → Task 4. ✅
- Blinkit Playwright fetcher + parsers → Task 5. ✅
- CLI window (`--since`/`--limit`, at least one required) + merge + fail-one-keep-rest → Task 6. ✅
- Fail-loud on no items (no silent drops) → Tasks 4/5 (`throw` when items empty). ✅
- Capture all charge lines → Tasks 2/4/5 (taxes/delivery/packaging/discount captured). ✅
- Skill orchestration + setup → Task 7. ✅
- Testing via fixtures (TDD) → every task. ✅
- Out of scope (filtering/Splitwise) → correctly excluded. ✅

**Placeholder scan:** No TBD/TODO. The two "representative fixture" notes are genuine data dependencies with explicit capture-and-adjust execution steps, not deferred work — the tests are complete and green against the synthetic fixtures.

**Type consistency:** `NormalizedOrder`, `OrderItem`, `Charges`, `Source` defined in Task 1 and used verbatim throughout. `openSession`/`LoginConfig`/`isLoggedOut` (Task 3) consumed unchanged in Tasks 4/5. `parseINR`/`applyWindow` (Task 1) consumed unchanged in Tasks 4/5. `mapZeptoOrders`/`fetchAmazonOrders`/`fetchBlinkitOrders` produced in Tasks 2/4/5 and consumed by `cli.ts` in Task 6 with matching signatures. `OrderRef` is intentionally local to each of amazon.ts/blinkit.ts (noted in Task 5 interfaces).
