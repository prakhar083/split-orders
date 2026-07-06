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
