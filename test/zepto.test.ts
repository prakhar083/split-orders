import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapZeptoOrders } from '../src/zepto.js';
import { reconcileCharges } from '../src/schema.js';

// Real order-detail payload captured from the official Zepto MCP (get_order_detail).
const payload = JSON.parse(readFileSync(new URL('./fixtures/zepto-payload.json', import.meta.url), 'utf8'));

describe('mapZeptoOrders', () => {
  it('maps real order-detail payload to NormalizedOrder[] (paise -> rupees)', () => {
    const orders = mapZeptoOrders(payload);
    expect(orders).toHaveLength(1);
    const o = orders[0];
    expect(o.source).toBe('zepto');
    expect(o.orderId).toBe('KSJVKBLAJ06551');
    expect(o.placedAt.startsWith('2026-07-16')).toBe(true);
    expect(o.items).toHaveLength(2);
    expect(o.items[0]).toMatchObject({ name: 'Classic Double Burst Cigarette', quantity: 1, unitPrice: 480, lineTotal: 480 });
    expect(o.items[1]).toMatchObject({ name: 'Amul High Protein Cup Dahi', quantity: 1, unitPrice: 80, lineTotal: 80 });
    expect(o.charges.subtotal).toBe(560);
    expect(o.grandTotal).toBe(560);
  });

  it('does not treat MRP savings (totalSaved) as a subtractable discount', () => {
    const o = mapZeptoOrders(payload)[0];
    expect(o.charges.discount).toBeUndefined();
    expect(reconcileCharges(o).ok).toBe(true);
  });
});
