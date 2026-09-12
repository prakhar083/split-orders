import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import { parseINR, flatText, applyWindow } from './util.js';
import { openSession, type LoginConfig } from './session.js';
import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

const ORDERS_URL = 'https://blinkit.com/account/orders';
// Clicking an order card navigates to a real, addressable route, so details are
// fetched by URL rather than by clicking through the list.
const orderDetailUrl = (ref: BlinkitOrderRef): string =>
  `${ORDERS_URL}/${ref.cartId}/${ref.orderId}`;
// "My Orders" only renders in the account nav once authenticated.
const BLINKIT_LOGIN: LoginConfig = { loginUrlPattern: /\/login|\/auth/i, authMarker: 'text=/My Orders/i' };

export interface BlinkitOrderRef {
  orderId: string;
  cartId: string;
  placedAt: string;
  grandTotal: number;
  status: string;
}

/**
 * Blinkit never renders an order id into the DOM — the account page keeps it in
 * the JSON it fetches for itself (`/v1/layout/order_history`), so the refs come
 * from that payload rather than from scraped markup.
 */

/** List dates carry no year ("11 Sep, 10:19 pm"); infer the most recent past one. */
export function blinkitDateToISO(text: string, now: Date = new Date()): string {
  const m = (text ?? '').match(/^\s*(\d{1,2})\s+([A-Za-z]+),\s*(\d{1,2}):(\d{2})\s*([ap])m\s*$/i);
  if (!m) return '';
  const [, day, month, hh, mm, ap] = m;
  const hour = (parseInt(hh, 10) % 12) + (/p/i.test(ap) ? 12 : 0);
  const build = (year: number): Date =>
    new Date(`${day} ${month} ${year} ${String(hour).padStart(2, '0')}:${mm}:00`);

  let d = build(now.getFullYear());
  if (Number.isNaN(d.getTime())) return '';
  // A date later than today can only mean it belongs to last year.
  if (d.getTime() > now.getTime() + 86_400_000) d = build(now.getFullYear() - 1);
  return d.toISOString();
}

/** Depth-first walk — the order cards sit at varying depths inside the widget tree. */
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const v of node) yield* walk(v);
  } else if (node && typeof node === 'object') {
    yield node as Record<string, unknown>;
    for (const v of Object.values(node as Record<string, unknown>)) yield* walk(v);
  }
}

export function parseBlinkitOrderHistory(payload: unknown, now: Date = new Date()): BlinkitOrderRef[] {
  const refs: BlinkitOrderRef[] = [];
  const seen = new Set<string>();
  for (const node of walk(payload)) {
    if (node.widget_type !== 'image_text_vr_type_header') continue;
    const tracking = (node.tracking ?? {}) as Record<string, unknown>;
    const attrs = (tracking.common_attributes ?? {}) as Record<string, unknown>;
    const data = (node.data ?? {}) as Record<string, unknown>;

    const orderId = String(attrs.order_id ?? '');
    const status = String(attrs.order_status ?? '');
    if (!orderId || seen.has(orderId)) continue;
    // Cancelled orders were never paid for, so they are not expenses.
    if (/cancel/i.test(status)) continue;

    // Two orders can share one cart (a split shipment), so the cart id is
    // carried alongside rather than used as the identity.
    const cartId = (String(attrs.deeplink ?? '').match(/cart_id=(\d+)/) ?? [])[1] ?? '';
    const total = ((data.left_underlined_subtitle ?? {}) as { text?: string }).text ?? '';
    const when = ((data.subtitle ?? {}) as { text?: string }).text ?? '';

    seen.add(orderId);
    refs.push({ orderId, cartId, placedAt: blinkitDateToISO(when, now), grandTotal: parseINR(total), status });
  }
  return refs;
}

export function parseBlinkitDetail(html: string, ref: BlinkitOrderRef): NormalizedOrder {
  const $ = cheerio.load(html);

  // Items are read from the DOM rather than from flattened text. Flattening
  // glues a row's price to the next row's name, and a product whose name
  // begins with digits ("4700BC Hawaiian…") then silently inflates the
  // previous item's price — ₹20 parsed as ₹204700. The markup keeps name,
  // "<size> x <qty>" and price as separate sibling nodes, so use that.
  const items: OrderItem[] = [];
  $('div').each((_, el) => {
    const $qty = $(el);
    if ($qty.children().length > 0) return; // leaf nodes only
    const m = $qty.text().trim().match(/^(.*?)\s*x\s*(\d+)$/i);
    if (!m) return;

    const $row = $qty.parent();
    const price = $row.children().last().text().trim();
    if (!price.startsWith('₹')) return;

    const name = $row.parent().children().first().text().replace(/\s+/g, ' ').trim();
    if (!name) return;

    const quantity = parseInt(m[2], 10) || 1;
    const lineTotal = parseINR(price);
    items.push({ name, quantity, unitPrice: +(lineTotal / quantity).toFixed(2), lineTotal });
  });
  if (items.length === 0) throw new Error(`Blinkit order ${ref.orderId}: no items parsed`);

  // The bill block is unambiguous as flat text: every label starts with a letter,
  // so an amount capture cannot run into the next label.
  const text = flatText(html);
  const bill = (text.match(/Bill details(.*?)(?:Order details|$)/i) ?? [])[1] ?? '';

  const amount = (label: string, src = text): number | undefined => {
    const mm = src.match(new RegExp(`${label}\\s*[+-]?\\s*₹([\\d,.]+)`, 'i'));
    return mm ? parseINR(mm[1]) : undefined;
  };
  // A fee shown as "FREE" was waived → charged 0, which differs from absent.
  const fee = (label: string): number | undefined =>
    new RegExp(`${label}\\s*FREE`, 'i').test(text) ? 0 : amount(label);

  const subtotal = amount('Item total') ?? items.reduce((s, i) => s + i.lineTotal, 0);
  const charges: Charges = { subtotal };
  const delivery = fee('Delivery charges?');
  if (delivery != null) charges.deliveryFee = delivery;
  const handling = fee('Handling charge');
  if (handling != null) charges.packagingFee = handling;

  // Blinkit adds situational surcharges ("Late night convenience charge", and
  // similar weather/surge fees). Rather than enumerate them, take every "+₹"
  // line in the bill that isn't one already accounted for.
  const KNOWN = /^(Handling charge|Delivery charges?|Item total|Bill total|MRP|Product discount|Tip)/i;
  let otherFees = 0;
  for (const mm of bill.matchAll(/([A-Za-z][A-Za-z ]*?)\s*\+\s*₹([\d,.]+)/g)) {
    if (KNOWN.test(mm[1].trim())) continue;
    otherFees += parseINR(mm[2]);
  }
  if (otherFees > 0) charges.otherFees = otherFees;

  const tip = amount('Tip');
  if (tip != null) charges.tip = tip;

  const grandTotal = amount('Bill total') ?? ref.grandTotal;

  // "Product discount" is MRP savings already reflected in "Item total" — it is
  // deliberately NOT subtracted. A coupon applied after the item total instead
  // shows up as the residual between the charged components and the bill total.
  const gross =
    subtotal + (charges.deliveryFee ?? 0) + (charges.packagingFee ?? 0) + (charges.otherFees ?? 0) + (charges.tip ?? 0);
  const residual = +(gross - grandTotal).toFixed(2);
  if (residual > 0.01) charges.discount = residual;

  return {
    source: 'blinkit',
    orderId: ref.orderId,
    placedAt: ref.placedAt,
    items,
    charges,
    grandTotal,
    currency: 'INR',
    raw: { html, ref },
  };
}

/** The order list lazy-loads 12 at a time as the page is scrolled. */
async function scrollForMore(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
        el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
}

export async function fetchBlinkitOrders(opts: { since?: string; limit?: number }): Promise<NormalizedOrder[]> {
  const { context, page } = await openSession('blinkit', ORDERS_URL, BLINKIT_LOGIN, { headless: true });
  try {
    // Order ids live only in the JSON the page fetches for itself, so refs are
    // accumulated from those responses as each page of history loads.
    const byId = new Map<string, BlinkitOrderRef>();
    page.on('response', async r => {
      if (!/\/v1\/layout\/order_history/.test(r.url())) return;
      try {
        for (const ref of parseBlinkitOrderHistory(JSON.parse(await r.text()))) {
          if (!byId.has(ref.orderId)) byId.set(ref.orderId, ref);
        }
      } catch {
        // A malformed page of history must not abort the whole run.
      }
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    // Keep scrolling until we have enough for the limit, have scrolled past the
    // --since date, or the history stops growing.
    let prevCount = 0;
    let stableRounds = 0;
    for (let i = 0; i < 60; i++) {
      const refs = [...byId.values()];
      if (opts.limit != null && refs.length >= opts.limit) break;
      const oldest = applyWindow(refs, {})[refs.length - 1]?.placedAt;
      if (opts.since && oldest && oldest < new Date(opts.since).toISOString()) break;
      if (refs.length === prevCount) {
        stableRounds++;
        if (stableRounds >= 5) break;
      } else {
        stableRounds = 0;
      }
      prevCount = refs.length;
      await scrollForMore(page);
      await page.waitForTimeout(1_200);
    }

    const wanted = applyWindow([...byId.values()], opts);
    const orders: NormalizedOrder[] = [];
    const failures: string[] = [];
    for (const ref of wanted) {
      try {
        await page.goto(orderDetailUrl(ref), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=/Bill details/i', { timeout: 30_000 });
        orders.push(parseBlinkitDetail(await page.content(), ref));
      } catch (e) {
        failures.push(`${ref.orderId}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    if (failures.length) {
      console.error(`[blinkit] ${failures.length}/${wanted.length} order(s) could not be read:\n  ${failures.join('\n  ')}`);
    }
    return orders;
  } finally {
    await context.close();
  }
}
