import type { NormalizedOrder, OrderItem } from './schema.js';
import type { Rules } from './categorize.js';

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface SplitResult {
  orderId: string;
  source: NormalizedOrder['source'];
  placedAt: string;
  sharedItems: OrderItem[];
  personalItems: OrderItem[];
  splitAmount: number;
  share: number;
}

export function computeSplit(order: NormalizedOrder, rules: Rules): SplitResult | null {
  const sharedItems: OrderItem[] = [];
  const personalItems: OrderItem[] = [];
  for (const item of order.items) {
    if (rules[item.name]?.shared === true) sharedItems.push(item);
    else personalItems.push(item);
  }

  const sharedSubtotal = sharedItems.reduce((s, i) => s + i.lineTotal, 0);
  if (sharedSubtotal === 0) return null;

  const totalSubtotal = order.charges.subtotal;
  const share = totalSubtotal > 0 ? sharedSubtotal / totalSubtotal : 0;

  const c = order.charges;
  const fullySharedFees = (c.deliveryFee ?? 0) + (c.packagingFee ?? 0) + (c.taxes ?? 0) + (c.tip ?? 0);
  const proratedDiscount = (c.discount ?? 0) * share;

  const splitAmount = round2(sharedSubtotal + fullySharedFees - proratedDiscount);

  return {
    orderId: order.orderId,
    source: order.source,
    placedAt: order.placedAt,
    sharedItems,
    personalItems,
    splitAmount,
    share,
  };
}
