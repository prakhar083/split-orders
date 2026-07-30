import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAmazonOrderList, parseAmazonNowDetail } from '../src/amazon.js';
import { reconcileCharges } from '../src/schema.js';

// Real captured pages from Amazon Now (tez) — grocery quick-commerce.
const list = readFileSync(new URL('./fixtures/amazon-list.html', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./fixtures/amazon-detail.html', import.meta.url), 'utf8');

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
});
