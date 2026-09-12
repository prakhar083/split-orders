import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBlinkitOrderHistory, parseBlinkitDetail } from '../src/blinkit.js';
import { reconcileCharges } from '../src/schema.js';

// Real captured payloads. The order list comes from the JSON the Blinkit page
// fetches for itself (order ids exist nowhere in the DOM); the detail is the
// captured "Order summary" modal, which does carry the itemized bill.
const history = JSON.parse(
  readFileSync(new URL('./fixtures/blinkit-order-history.json', import.meta.url), 'utf8'),
);
const detail = readFileSync(new URL('./fixtures/blinkit-detail.html', import.meta.url), 'utf8');
// A real order that broke the first implementation twice over: a product whose
// NAME starts with digits ("4700BC Hawaiian…"), and a "Late night convenience
// charge" fee type beyond the usual delivery/handling pair.
const detailFees = readFileSync(new URL('./fixtures/blinkit-detail-fees.html', import.meta.url), 'utf8');

describe('parseBlinkitOrderHistory', () => {
  it('extracts every order card with its real order id', () => {
    const refs = parseBlinkitOrderHistory(history);
    expect(refs.length).toBe(10);
    expect(refs[0]).toMatchObject({
      orderId: '2656204568',
      cartId: '3884726099',
      grandTotal: 223,
    });
    expect(refs[0].placedAt.slice(0, 10)).toBe('2026-09-11');
  });

  it('carries the cart id, which the detail view needs alongside the order id', () => {
    const refs = parseBlinkitOrderHistory(history);
    expect(refs[1]).toMatchObject({ orderId: '2650502863', cartId: '3878905884', grandTotal: 212 });
  });

  it('keeps two orders that share one cart id distinct (split shipment)', () => {
    const refs = parseBlinkitOrderHistory(history);
    const shared = refs.filter(r => r.cartId === '3814618261');
    expect(shared.map(r => r.orderId).sort()).toEqual(['2589330319', '2589330320']);
  });

  it('infers the year as the most recent past occurrence, never the future', () => {
    const refs = parseBlinkitOrderHistory(history);
    for (const r of refs) expect(new Date(r.placedAt).getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it('skips cancelled orders', () => {
    const one = (id: string, status: string) => ({
      widget_type: 'image_text_vr_type_header',
      data: { left_underlined_subtitle: { text: '₹100' }, subtitle: { text: '01 Aug, 1:00 pm' } },
      tracking: { common_attributes: { order_id: id, order_status: status, deeplink: 'x?cart_id=9&order_id=' + id } },
    });
    const refs = parseBlinkitOrderHistory({ response: { snippets: [one('1', 'DELIVERED'), one('2', 'CANCELLED')] } });
    expect(refs.map(r => r.orderId)).toEqual(['1']);
  });
});

describe('parseBlinkitDetail', () => {
  const ref = { orderId: '2650502863', cartId: '3878905884', placedAt: '2026-09-10T18:24:00.000Z', grandTotal: 212, status: 'DELIVERED' };

  it('parses every item with its name, quantity and line total', () => {
    const o = parseBlinkitDetail(detail, ref);
    expect(o.items.length).toBe(6);
    expect(o.items[0]).toMatchObject({ name: 'Kurkure Chilli Chatka Crisps', quantity: 1, lineTotal: 20 });
    expect(o.items[2]).toMatchObject({ name: 'Amul Probiotic High Protein Curd', lineTotal: 80 });
    expect(o.items[5]).toMatchObject({ name: 'Coca-Cola Zero Sugar Soft Drink', lineTotal: 40 });
    // Pack sizes must not leak into the name — rules.json is keyed by exact name.
    expect(o.items.every(i => !/\d+(\.\d+)?\s*(g|ml|kg|l)\b/.test(i.name))).toBe(true);
  });

  it('parses the bill, treating a waived delivery fee as zero', () => {
    const o = parseBlinkitDetail(detail, ref);
    expect(o.charges.subtotal).toBe(200);
    expect(o.charges.packagingFee).toBe(12);
    expect(o.charges.deliveryFee).toBe(0);
    expect(o.grandTotal).toBe(212);
  });

  it('does NOT subtract the product discount, which is already inside the item total', () => {
    // MRP ₹205 − product discount ₹5 = item total ₹200. Subtracting again would
    // under-report the shared amount on every discounted order.
    const o = parseBlinkitDetail(detail, ref);
    expect(o.charges.discount).toBeUndefined();
    expect(o.items.reduce((s, i) => s + i.lineTotal, 0)).toBe(o.charges.subtotal);
  });

  it('produces an order that reconciles and carries identity from the ref', () => {
    const o = parseBlinkitDetail(detail, ref);
    expect(o.source).toBe('blinkit');
    expect(o.orderId).toBe('2650502863');
    expect(o.placedAt).toBe(ref.placedAt);
    expect(o.currency).toBe('INR');
    expect(reconcileCharges(o).ok).toBe(true);
  });
});

describe('parseBlinkitDetail — digit-leading names and extra fees', () => {
  const ref = { orderId: '2638799842', cartId: '3866907189', placedAt: '2026-09-08T20:07:00.000Z', grandTotal: 266, status: 'DELIVERED' };

  it('keeps a product whose name starts with digits intact', () => {
    const o = parseBlinkitDetail(detailFees, ref);
    const popcorn = o.items.find(i => /Hawaiian/.test(i.name));
    expect(popcorn?.name).toBe('4700BC Hawaiian Barbeque Cheese Popcorn, Gourmet');
    expect(popcorn?.lineTotal).toBe(50);
  });

  it('does not let a digit-leading name inflate the previous item\'s price', () => {
    const o = parseBlinkitDetail(detailFees, ref);
    const kurkure = o.items.find(i => /Kurkure/.test(i.name));
    expect(kurkure?.lineTotal).toBe(20); // was 204700 when parsed from flattened text
  });

  it('parses all four items and they sum to the item total', () => {
    const o = parseBlinkitDetail(detailFees, ref);
    expect(o.items.length).toBe(4);
    expect(o.items.reduce((s, i) => s + i.lineTotal, 0)).toBe(239);
    expect(o.charges.subtotal).toBe(239);
  });

  it('captures an unrecognised fee instead of silently dropping it', () => {
    const o = parseBlinkitDetail(detailFees, ref);
    expect(o.charges.packagingFee).toBe(12);
    expect(o.charges.deliveryFee).toBe(0);
    expect(o.charges.otherFees).toBe(15); // "Late night convenience charge"
    expect(o.grandTotal).toBe(266);
  });

  it('reconciles once the extra fee is accounted for', () => {
    const o = parseBlinkitDetail(detailFees, ref);
    const r = reconcileCharges(o);
    expect(r.ok).toBe(true);
    expect(r.diff).toBe(0);
  });

  it('still records no discount — the product discount sits inside the item total', () => {
    const o = parseBlinkitDetail(detailFees, ref);
    expect(o.charges.discount).toBeUndefined();
  });
});
