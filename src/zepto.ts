import type { NormalizedOrder, OrderItem, Charges } from './schema.js';

interface ZeptoItem { name: string; quantity: number; price: number }
interface ZeptoBill { item_total: number; tax?: number; delivery_charge?: number; packaging_charge?: number; discount?: number }
interface ZeptoOrder { order_id: string; placed_at: string; items: ZeptoItem[]; bill: ZeptoBill; grand_total: number }

export function mapZeptoOrders(payload: unknown): NormalizedOrder[] {
  const orders = (payload as { orders?: ZeptoOrder[] })?.orders ?? [];
  return orders.map((o): NormalizedOrder => {
    const items: OrderItem[] = o.items.map(i => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.price,
      lineTotal: +(i.price * i.quantity).toFixed(2),
    }));
    const charges: Charges = { subtotal: o.bill.item_total };
    if (o.bill.tax != null) charges.taxes = o.bill.tax;
    if (o.bill.delivery_charge != null) charges.deliveryFee = o.bill.delivery_charge;
    if (o.bill.packaging_charge != null) charges.packagingFee = o.bill.packaging_charge;
    if (o.bill.discount != null) charges.discount = o.bill.discount;
    return {
      source: 'zepto',
      orderId: o.order_id,
      placedAt: new Date(o.placed_at).toISOString(),
      items,
      charges,
      grandTotal: o.grand_total,
      currency: 'INR',
      raw: o,
    };
  });
}
