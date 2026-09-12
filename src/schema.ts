export type Source = 'zepto' | 'amazon' | 'blinkit';

export interface OrderItem {
  name: string;
  quantity: number;
  unitPrice?: number;
  lineTotal: number;
}

export interface Charges {
  subtotal: number;
  taxes?: number;
  deliveryFee?: number;
  packagingFee?: number;
  discount?: number;
  tip?: number;
  /** Charged fees that don't map to a named field (e.g. a late-night or
   *  bad-weather surcharge). Kept explicit so reconciliation stays honest
   *  instead of absorbing them into a bogus discount. */
  otherFees?: number;
}

export interface NormalizedOrder {
  source: Source;
  orderId: string;
  placedAt: string; // ISO 8601
  items: OrderItem[];
  charges: Charges;
  grandTotal: number;
  currency: 'INR';
  raw?: unknown;
}

export function validateOrder(o: unknown): string[] {
  const errs: string[] = [];
  const order = o as Partial<NormalizedOrder>;
  if (!order || typeof order !== 'object') return ['not an object'];
  if (!['zepto', 'amazon', 'blinkit'].includes(order.source as string)) errs.push('invalid source');
  if (!order.orderId) errs.push('missing orderId');
  if (!order.placedAt || Number.isNaN(new Date(order.placedAt).getTime())) errs.push('invalid placedAt');
  if (!Array.isArray(order.items) || order.items.length === 0) errs.push('missing items');
  if (order.currency !== 'INR') errs.push('currency must be INR');
  if (typeof order.grandTotal !== 'number') errs.push('missing grandTotal');
  if (!order.charges || typeof order.charges.subtotal !== 'number') errs.push('missing charges.subtotal');
  return errs;
}

export function reconcileCharges(o: NormalizedOrder): { ok: boolean; expected: number; diff: number } {
  const c = o.charges;
  const expected =
    c.subtotal +
    (c.taxes ?? 0) +
    (c.deliveryFee ?? 0) +
    (c.packagingFee ?? 0) +
    (c.tip ?? 0) +
    (c.otherFees ?? 0) -
    (c.discount ?? 0);
  const diff = Math.round((o.grandTotal - expected) * 100) / 100;
  return { ok: Math.abs(diff) <= 1, expected, diff };
}
