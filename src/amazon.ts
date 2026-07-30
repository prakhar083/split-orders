import * as cheerio from 'cheerio';
import { parseINR, applyWindow } from './util.js';
import { openSession, type LoginConfig } from './session.js';
import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

export interface OrderRef { orderId: string; placedAt: string; grandTotal: number }

// Amazon Now (quick-commerce grocery) orders list — grocery-only, so no "now"
// badge filtering is needed.
const QCBRAND = 'qqfsWw9RkO';
const ORDERS_URL = `https://www.amazon.in/tez/browse/yourOrders?qcbrand=${QCBRAND}`;
const orderDetailUrl = (orderId: string): string =>
  `https://www.amazon.in/tez/browse/orderTracking?qcbrand=${QCBRAND}&orderID=${orderId}`;
// 'main' matched the sign-in page too (too generic), so the login-wait resolved
// instantly without a real login. "Your Orders" only renders once authenticated.
const AMAZON_LOGIN: LoginConfig = { loginUrlPattern: /\/ap\/signin/, authMarker: 'text=/Your Orders/i' };

const ORDER_NO = /40[0-9]-\d{7}-\d{7}/;

/** Actual amount paid = the lowest value in a run of `₹X₹Y…` (paid vs struck MRP). */
function paid(prices: string): number {
  const nums = (prices.match(/₹[\d,]+/g) ?? []).map(parseINR);
  return nums.length ? Math.min(...nums) : 0;
}

function flatText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style').remove();
  return $('body').text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** List dates carry no year; infer the most recent past occurrence, at UTC midnight. */
function listDateToISO(dayMonth: string): string {
  const now = new Date();
  const d = new Date(`${dayMonth} ${now.getFullYear()}`);
  if (Number.isNaN(d.getTime())) return '';
  if (d.getTime() > now.getTime() + 86_400_000) d.setFullYear(now.getFullYear() - 1);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
}

export function parseAmazonOrderList(html: string): OrderRef[] {
  const text = flatText(html);
  // Each card: "<status> … <date?> … #<order>Total: ₹<amt>". Cancelled orders carry
  // no date and ₹0 — they are not real expenses, so they are skipped.
  const re = /(Delivered|Arriving|Cancelled|Refunded|Order Cancelled|Order Refunded)([^#]*?)#(40[0-9]-\d{7}-\d{7})Total:\s*₹([\d,.]+)/g;
  const refs: OrderRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const status = m[1];
    const orderId = m[3];
    const grandTotal = parseINR(m[4]);
    if (seen.has(orderId)) continue;
    if (/cancel/i.test(status) || grandTotal === 0) continue;
    seen.add(orderId);
    const dateMatch = m[2].match(/(\d{1,2}\s+[A-Za-z]+)/);
    refs.push({ orderId, placedAt: dateMatch ? listDateToISO(dateMatch[1]) : '', grandTotal });
  }
  return refs;
}

export function parseAmazonNowDetail(html: string): NormalizedOrder {
  const text = flatText(html);
  const orderId = (text.match(/#(40[0-9]-\d{7}-\d{7})/) ?? [])[1] ?? '';

  // Date order varies ("29 July 2026" vs "July 29, 2026") depending on how Amazon
  // renders it, so capture the date chunk generically and let Date() parse it.
  const dm = text.match(/Order placed\s*(?:[A-Za-z]+,\s*)?(.+?)\s+at\s+([\d:]+\s*[ap]m)/i);
  const placedAt = dm ? new Date(`${dm[1]} ${dm[2]}`).toISOString() : '';

  // Priced item rows live between "N item(s) in order" and "Bill summary".
  // A single-item order says "1 item in order" (singular) — without the
  // optional 's', the match fails and falls back to the WHOLE page text,
  // picking up unrelated banner text (e.g. a lost-connection notice) as items.
  const segMatch = text.match(/items? in order(.*?)Bill summary/i);
  if (!segMatch) throw new Error(`Amazon order ${orderId}: could not locate the items section`);
  const seg = segMatch[1];
  const items: OrderItem[] = [];
  // Flattening loses the boundary between a product name and its pack size
  // (e.g. "Corn Starch (Cornflour)500 g"), so the name capture stops right
  // before a size token (digit+unit, or "Pack ") instead of swallowing it.
  const itemRe = /([^₹]+?)(?:\d+(?:\.\d+)?\s?(?:g|kg|ml|l|pcs?)\b|Pack\s)[^₹]*?\s*\.\s*(\d+)\s*units?\s*((?:₹[\d,]+)+)/gi;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(seg))) {
    const name = im[1].replace(/\s+/g, ' ').trim();
    const quantity = parseInt(im[2], 10) || 1;
    const lineTotal = paid(im[3]);
    items.push({ name, quantity, unitPrice: +(lineTotal / quantity).toFixed(2), lineTotal });
  }

  const pair = (label: string): number | undefined => {
    const mm = text.match(new RegExp(label + '[^₹]*((?:₹[\\d,]+)+)', 'i'));
    return mm ? paid(mm[1]) : undefined;
  };
  // A fee shown as "₹30 … Free" was waived → charged 0.
  const feeCharged = (label: string): number | undefined => {
    const mm = text.match(new RegExp(label + '[^₹]*?₹([\\d,]+)\\s*(Free)?', 'i'));
    if (!mm) return /Free/i.test(text.slice(text.search(new RegExp(label, 'i')) + label.length, 0 + 40)) ? 0 : undefined;
    return mm[2] ? 0 : parseINR(mm[1]);
  };

  const subtotal = pair('Items total') ?? items.reduce((s, i) => s + i.lineTotal, 0);
  const charges: Charges = { subtotal };
  const delivery = feeCharged('Delivery fee');
  if (delivery != null) charges.deliveryFee = delivery;
  const handling = feeCharged('Handling fee');
  if (handling != null) charges.packagingFee = handling;

  const grandTotal = pair('You pay') ?? subtotal;
  const gross = subtotal + (charges.deliveryFee ?? 0) + (charges.packagingFee ?? 0);
  const residual = +(gross - grandTotal).toFixed(2);
  if (residual > 0.01) charges.discount = residual;

  if (items.length === 0) throw new Error(`Amazon order ${orderId}: no items parsed`);
  return { source: 'amazon', orderId, placedAt, items, charges, grandTotal, currency: 'INR', raw: { html } };
}

export async function fetchAmazonOrders(opts: { since?: string; limit?: number }): Promise<NormalizedOrder[]> {
  const { context, page } = await openSession('amazon', ORDERS_URL, AMAZON_LOGIN, { headless: true });
  try {
    await page.waitForSelector(`text=/${ORDER_NO.source}/`, { timeout: 30_000 }).catch(() => undefined);

    // Load more pages until we plausibly have enough (bounded to avoid runaway).
    for (let i = 0; i < 20; i++) {
      const refs = parseAmazonOrderList(await page.content());
      if (opts.limit != null && refs.length >= opts.limit) break;
      const more = page.locator('text=/See more|Load more/i').first();
      if (!(await more.count())) break;
      await more.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    const refs = applyWindow(parseAmazonOrderList(await page.content()), opts);
    const orders: NormalizedOrder[] = [];
    for (const ref of refs) {
      await page.goto(orderDetailUrl(ref.orderId), { waitUntil: 'domcontentloaded' });
      // The order-tracking page only shows a summary; the itemized bill lives in
      // a client-side panel that's in the DOM but hidden until this button is
      // clicked (it's a `role="link"` button, not a real navigable href).
      await page.getByText('View order details', { exact: true }).first().click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForSelector('text=/Bill summary/i', { timeout: 30_000 });
      orders.push(parseAmazonNowDetail(await page.content()));
    }
    return orders;
  } finally {
    await context.close();
  }
}
