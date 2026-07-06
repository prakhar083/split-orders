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
