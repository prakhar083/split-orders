import * as cheerio from 'cheerio';
import { parseINR, applyWindow } from './util.js';
import { openSession, type LoginConfig } from './session.js';
import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

export interface OrderRef { orderId: string; detailUrl: string; placedAt: string }

const AMAZON_LOGIN: LoginConfig = { loginUrlPattern: /\/ap\/signin/, authMarker: '#nav-link-accountList, #nav-user' };
const ORIGIN = 'https://www.amazon.in';

function isoFromOrderedOn(text: string): string {
  const m = text.replace(/Ordered on/i, '').trim();
  // Amazon order dates are date-only; rebuild at UTC midnight so the ISO day is
  // stable regardless of the machine's timezone.
  const d = new Date(m);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
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
