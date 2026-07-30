import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAmazonOrderList, parseAmazonNowDetail } from '../src/amazon.js';
import { reconcileCharges } from '../src/schema.js';

// Real captured pages from Amazon Now (tez) — grocery quick-commerce.
const list = readFileSync(new URL('./fixtures/amazon-list.html', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./fixtures/amazon-detail.html', import.meta.url), 'utf8');
// Reproduces real-world text patterns a live fetch hit and this fixture didn't:
// a "N units" (plural, qty > 1) row, an item with only one price (no MRP shown),
// and a "Month D, YYYY" date order instead of "D Month YYYY".
const detail2 = readFileSync(new URL('./fixtures/amazon-detail-2.html', import.meta.url), 'utf8');
// Reproduces a real bug: a 1-item order says "1 item in order" (singular),
// preceded by an unrelated "lost connection" banner earlier on the page.
const detailSingle = readFileSync(new URL('./fixtures/amazon-detail-single-item.html', import.meta.url), 'utf8');

describe('parseAmazonOrderList', () => {
  it('extracts real order refs and skips cancelled/₹0 orders', () => {
    const refs = parseAmazonOrderList(list);
    // 10 order numbers in the page; one is "Order Cancelled … ₹0" and is skipped.
    expect(refs.length).toBe(9);
    expect(refs.some(r => r.orderId === '402-0468819-6077164')).toBe(false);
    expect(refs[0].orderId).toBe('402-2073571-9888302');
    expect(refs[0].grandTotal).toBe(504);
    expect(refs[1]).toMatchObject({ orderId: '402-6686440-5103514', grandTotal: 986 });
  });

  it('infers a date (month-day stable regardless of run year)', () => {
    const refs = parseAmazonOrderList(list);
    expect(refs[0].placedAt.slice(5, 10)).toBe('07-29');
  });
});

describe('parseAmazonNowDetail', () => {
  it('extracts all 6 items with actual paid prices', () => {
    const o = parseAmazonNowDetail(detail);
    expect(o.source).toBe('amazon');
    expect(o.orderId).toBe('402-2073571-9888302');
    expect(o.items).toHaveLength(6);
    expect(o.items[0]).toMatchObject({ quantity: 1, lineTotal: 82 });
    expect(o.items[0].name).toContain('Weikfield Corn Starch');
    // paid prices sum to the bill
    const itemsSum = o.items.reduce((s, i) => s + i.lineTotal, 0);
    expect(itemsSum).toBe(504);
  });

  it('reads the bill summary (waived fees = 0) and reconciles', () => {
    const o = parseAmazonNowDetail(detail);
    expect(o.charges.subtotal).toBe(504);
    expect(o.charges.deliveryFee).toBe(0);
    expect(o.charges.packagingFee).toBe(0);
    expect(o.grandTotal).toBe(504);
    expect(reconcileCharges(o).ok).toBe(true);
  });

  it('parses the placed-at date with year', () => {
    const o = parseAmazonNowDetail(detail);
    expect(o.placedAt.startsWith('2026-07-29')).toBe(true);
  });

  it('handles a plural "N units" row, a single-price item, and month-first dates', () => {
    const o = parseAmazonNowDetail(detail2);
    expect(o.orderId).toBe('402-6686440-5103514');
    expect(o.items).toHaveLength(7);
    // "2 units" (plural) must not be dropped, and no digits from its second
    // price should leak into the following item's name.
    expect(o.items[0]).toMatchObject({ name: 'India Gate Classic Pure Basmati Rice', quantity: 2, lineTotal: 514 });
    expect(o.items[1].name).toBe('Eastern Chicken Masala');
    // An item with only one price (no struck-through MRP) still parses.
    expect(o.items[3]).toMatchObject({ name: 'Coca-Cola Zero Sugar Soft Drink Can', quantity: 1, lineTotal: 40 });
    const itemsSum = o.items.reduce((s, i) => s + i.lineTotal, 0);
    expect(itemsSum).toBe(986);
    expect(o.charges.subtotal).toBe(986);
    expect(o.grandTotal).toBe(986);
    expect(reconcileCharges(o).ok).toBe(true);
    // "Wed, July 23, 2026 at 9:24 pm" — month before day, unlike the other fixture.
    expect(o.placedAt.startsWith('2026-07-23')).toBe(true);
  });

  it('handles a singular "1 item in order" without leaking preceding banner text', () => {
    const o = parseAmazonNowDetail(detailSingle);
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ name: "Nandu's Boneless Chicken Breast", quantity: 1, lineTotal: 249 });
    expect(o.charges.subtotal).toBe(249);
    expect(o.grandTotal).toBe(249);
    expect(reconcileCharges(o).ok).toBe(true);
  });
});
