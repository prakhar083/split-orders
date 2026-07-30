import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { guessCategory, loadRules, saveRules, dedupeItems, type Rules } from '../src/categorize.js';
import type { NormalizedOrder } from '../src/schema.js';

describe('guessCategory', () => {
  it('recognizes tobacco/alcohol keywords', () => {
    expect(guessCategory('Classic Double Burst Cigarette')).toBe('tobacco-alcohol');
  });
  it('recognizes grocery keywords', () => {
    expect(guessCategory('Amul High Protein Cup Dahi')).toBe('grocery');
    expect(guessCategory('Fresh Cauliflower Small')).toBe('grocery');
  });
  it('recognizes personal-hygiene keywords', () => {
    expect(guessCategory('Dove Shampoo 340ml')).toBe('personal-hygiene');
  });
  it('falls back to other when nothing matches', () => {
    expect(guessCategory('Mystery Widget 3000')).toBe('other');
  });
});

const TMP_RULES = new URL('./fixtures/tmp-rules.json', import.meta.url).pathname;

describe('loadRules / saveRules', () => {
  it('returns {} when the file does not exist', () => {
    if (existsSync(TMP_RULES)) unlinkSync(TMP_RULES);
    expect(loadRules(TMP_RULES)).toEqual({});
  });
  it('round-trips saved rules', () => {
    const rules: Rules = { 'Amul Milk': { category: 'grocery', shared: true } };
    saveRules(TMP_RULES, rules);
    expect(loadRules(TMP_RULES)).toEqual(rules);
    unlinkSync(TMP_RULES);
  });
});

const order = (items: { name: string }[]): NormalizedOrder => ({
  source: 'zepto', orderId: 'X', placedAt: '2026-07-01T00:00:00.000Z',
  items: items.map(i => ({ ...i, quantity: 1, lineTotal: 10 })),
  charges: { subtotal: 10 }, grandTotal: 10, currency: 'INR',
});

describe('dedupeItems', () => {
  it('unions item names across orders without duplicates', () => {
    const orders = [order([{ name: 'Milk' }, { name: 'Bread' }]), order([{ name: 'Milk' }])];
    const result = dedupeItems(orders, {});
    expect(result.map(r => r.name).sort()).toEqual(['Bread', 'Milk']);
  });
  it('marks items with an existing rule as hasRule and uses the saved category', () => {
    const orders = [order([{ name: 'Classic Double Burst Cigarette' }])];
    const rules: Rules = { 'Classic Double Burst Cigarette': { category: 'other', shared: false } };
    const result = dedupeItems(orders, rules);
    expect(result).toEqual([{ name: 'Classic Double Burst Cigarette', category: 'other', hasRule: true }]);
  });
  it('guesses a category for items with no saved rule', () => {
    const orders = [order([{ name: 'Fresh Cauliflower Small' }])];
    const result = dedupeItems(orders, {});
    expect(result).toEqual([{ name: 'Fresh Cauliflower Small', category: 'grocery', hasRule: false }]);
  });
});
