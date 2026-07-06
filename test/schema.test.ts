import { describe, it, expect } from 'vitest';
import { validateOrder, reconcileCharges, type NormalizedOrder } from '../src/schema.js';

const good: NormalizedOrder = {
  source: 'amazon', orderId: 'X1', placedAt: '2026-07-03T00:00:00.000Z',
  items: [{ name: 'Salt', quantity: 2, unitPrice: 28, lineTotal: 56 }],
  charges: { subtotal: 56, deliveryFee: 40 }, grandTotal: 96, currency: 'INR',
};

describe('validateOrder', () => {
  it('accepts a well-formed order', () => {
    expect(validateOrder(good)).toEqual([]);
  });
  it('flags missing/invalid fields', () => {
    const bad = { ...good, orderId: '', items: [] };
    const errs = validateOrder(bad);
    expect(errs.some(e => e.includes('orderId'))).toBe(true);
    expect(errs.some(e => e.includes('items'))).toBe(true);
  });
});

describe('reconcileCharges', () => {
  it('accepts totals within ±1 INR', () => {
    expect(reconcileCharges(good).ok).toBe(true);
  });
  it('flags a mismatch and reports the diff', () => {
    const r = reconcileCharges({ ...good, grandTotal: 120 });
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(24);
  });
  it('treats discount as a positive reduction', () => {
    const withDisc: NormalizedOrder = {
      ...good, charges: { subtotal: 56, deliveryFee: 40, discount: 16 }, grandTotal: 80,
    };
    expect(reconcileCharges(withDisc).ok).toBe(true);
  });
});
