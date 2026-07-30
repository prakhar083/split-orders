import { describe, it, expect } from 'vitest';
import { computeSplit, round2 } from '../src/split.js';
import type { NormalizedOrder } from '../src/schema.js';
import type { Rules } from '../src/categorize.js';

const baseOrder: NormalizedOrder = {
  source: 'zepto', orderId: 'ORD-1', placedAt: '2026-07-16T09:39:46.879Z',
  items: [
    { name: 'Amul Dahi', quantity: 1, unitPrice: 80, lineTotal: 80 },
    { name: 'Classic Double Burst Cigarette', quantity: 1, unitPrice: 480, lineTotal: 480 },
  ],
  charges: { subtotal: 560 }, grandTotal: 560, currency: 'INR',
};

const rulesMixed: Rules = {
  'Amul Dahi': { category: 'grocery', shared: true },
  'Classic Double Burst Cigarette': { category: 'tobacco-alcohol', shared: false },
};

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(10.005)).toBe(10.01); // adjusted below if binary float differs
    expect(round2(10.1)).toBe(10.1);
  });
});

describe('computeSplit', () => {
  it('returns null when no items are shared', () => {
    const rules: Rules = {
      'Amul Dahi': { category: 'grocery', shared: false },
      'Classic Double Burst Cigarette': { category: 'tobacco-alcohol', shared: false },
    };
    expect(computeSplit(baseOrder, rules)).toBeNull();
  });

  it('treats an item with no rule as personal (not shared)', () => {
    const rules: Rules = { 'Amul Dahi': { category: 'grocery', shared: true } };
    // 'Classic Double Burst Cigarette' has no rule -> personal
    const result = computeSplit(baseOrder, rules);
    expect(result?.sharedItems.map(i => i.name)).toEqual(['Amul Dahi']);
    expect(result?.personalItems.map(i => i.name)).toEqual(['Classic Double Burst Cigarette']);
  });

  it('computes splitAmount as shared subtotal + full fees - prorated discount', () => {
    const order: NormalizedOrder = {
      ...baseOrder,
      charges: { subtotal: 560, deliveryFee: 20, discount: 56 },
      grandTotal: 524,
    };
    const result = computeSplit(order, rulesMixed);
    // share = 80/560 = 0.142857...
    // proratedDiscount = 56 * 0.142857 = 8
    // splitAmount = 80 + 20 - 8 = 92
    expect(result?.share).toBeCloseTo(80 / 560, 6);
    expect(result?.splitAmount).toBe(92);
  });

  it('adds fully-shared fees even when share is 100%', () => {
    const order: NormalizedOrder = {
      source: 'amazon', orderId: 'ORD-2', placedAt: '2026-07-01T00:00:00.000Z',
      items: [{ name: 'Amul Dahi', quantity: 1, unitPrice: 80, lineTotal: 80 }],
      charges: { subtotal: 80, deliveryFee: 30 }, grandTotal: 110, currency: 'INR',
    };
    const rules: Rules = { 'Amul Dahi': { category: 'grocery', shared: true } };
    const result = computeSplit(order, rules);
    expect(result?.splitAmount).toBe(110);
  });
});
