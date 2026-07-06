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
