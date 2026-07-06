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
