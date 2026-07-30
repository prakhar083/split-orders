import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

// Zepto's API returns all monetary values in paise (₹1 = 100).
const P = (n: number | undefined): number => Math.round((n ?? 0)) / 100;

interface ZeptoProduct {
  productName: string;
  quantityOrdered: number;
  quantityFulfilled?: number;
  unitSellingPrice: number; // paise
  totalFinalSellingPrice: number; // paise
}

interface ZeptoShipment { products?: ZeptoProduct[] }

interface ZeptoBillSummary {
  itemTotal: number; // paise, post-MRP-discount selling total
  totalBill: number; // paise, amount actually charged
  totalSaved?: number; // paise, MRP savings (already reflected in itemTotal — NOT a subtractable discount)
  deliveryCharge?: number; // paise (present only on fee-bearing orders)
  handlingCharge?: number; // paise
  tax?: number; // paise
  tip?: number; // paise
}

interface ZeptoOrderDetail {
  id: string;
  code: string;
  placedTime: string;
  grandTotalAmount: number; // paise
  billSummary?: ZeptoBillSummary;
  shipments?: ZeptoShipment[];
}

export function mapZeptoOrderDetail(o: ZeptoOrderDetail): NormalizedOrder {
  const products = (o.shipments ?? []).flatMap(s => s.products ?? []);
  const items: OrderItem[] = products.map(p => ({
    name: p.productName,
    quantity: p.quantityOrdered,
    unitPrice: P(p.unitSellingPrice),
    lineTotal: P(p.totalFinalSellingPrice),
  }));

  const b = o.billSummary ?? ({} as ZeptoBillSummary);
  const subtotal = P(b.itemTotal);
  const charges: Charges = { subtotal };
  if (b.deliveryCharge != null) charges.deliveryFee = P(b.deliveryCharge);
  if (b.handlingCharge != null) charges.packagingFee = P(b.handlingCharge);
  if (b.tax != null) charges.taxes = P(b.tax);
  if (b.tip != null) charges.tip = P(b.tip);

  const grandTotal = b.totalBill != null ? P(b.totalBill) : P(o.grandTotalAmount);

  // Any coupon/other reduction shows up as the residual between the charged
  // components and the grand total. (totalSaved is MRP savings, already inside
  // itemTotal, so it is deliberately not used here.)
  const gross =
    subtotal + (charges.deliveryFee ?? 0) + (charges.packagingFee ?? 0) + (charges.taxes ?? 0) + (charges.tip ?? 0);
  const residual = +(gross - grandTotal).toFixed(2);
  if (residual > 0.01) charges.discount = residual;

  return {
    source: 'zepto',
    orderId: o.code || o.id,
    placedAt: new Date(o.placedTime).toISOString(),
    items,
    charges,
    grandTotal,
    currency: 'INR',
    raw: o,
  };
}

/**
 * Map Zepto order-detail payloads to NormalizedOrder[].
 * Accepts either an array of order-detail objects, or `{ orders: [...] }`.
 */
export function mapZeptoOrders(payload: unknown): NormalizedOrder[] {
  const details: ZeptoOrderDetail[] = Array.isArray(payload)
    ? (payload as ZeptoOrderDetail[])
    : ((payload as { orders?: ZeptoOrderDetail[] })?.orders ?? []);
  return details.map(mapZeptoOrderDetail);
}
