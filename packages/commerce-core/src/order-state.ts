import { type Db, insert, nowIso } from "@astro/db";
import type { OrderState } from "@astro/shared-types";

/**
 * Order state machine. Every transition is validated and recorded in order_transitions.
 * Terminal states: REFUNDED, CANCELLED, DELIVERED (can still go to REFUND_REQUESTED/DISPUTED), FAILED.
 */
export const ORDER_TRANSITIONS: Record<OrderState, OrderState[]> = {
  CREATED: ["PAYMENT_PENDING", "PAID", "CANCELLED", "FAILED"],
  PAYMENT_PENDING: ["PAID", "CANCELLED", "FAILED"],
  PAID: ["VALIDATING", "MANUAL_REVIEW", "REFUND_REQUESTED", "DISPUTED", "CANCELLED"],
  // A chargeback (DISPUTED) or a refund request can arrive at ANY point after payment (red team P1: the
  // dispute webhook and post-purchase refunds used to throw InvalidTransition from the supplier states).
  VALIDATING: ["READY_FOR_FULFILLMENT", "MANUAL_REVIEW", "FAILED", "REFUND_REQUESTED", "DISPUTED"],
  MANUAL_REVIEW: [
    "READY_FOR_FULFILLMENT",
    "VALIDATING",
    "REFUND_REQUESTED",
    "CANCELLED",
    "FAILED",
    "DISPUTED",
  ],
  READY_FOR_FULFILLMENT: ["SUPPLIER_SUBMITTED", "MANUAL_REVIEW", "REFUND_REQUESTED", "CANCELLED", "DISPUTED"],
  SUPPLIER_SUBMITTED: [
    "SUPPLIER_CONFIRMED",
    "PROCESSING",
    "MANUAL_REVIEW",
    "FAILED",
    "CANCELLED",
    "REFUND_REQUESTED",
    "DISPUTED",
  ],
  SUPPLIER_CONFIRMED: ["PROCESSING", "SHIPPED", "MANUAL_REVIEW", "CANCELLED", "REFUND_REQUESTED", "DISPUTED"],
  PROCESSING: ["SHIPPED", "MANUAL_REVIEW", "CANCELLED", "REFUND_REQUESTED", "DISPUTED"],
  SHIPPED: ["IN_TRANSIT", "DELIVERED", "REFUND_REQUESTED", "DISPUTED", "MANUAL_REVIEW"],
  IN_TRANSIT: ["DELIVERED", "REFUND_REQUESTED", "DISPUTED", "MANUAL_REVIEW"],
  DELIVERED: ["REFUND_REQUESTED", "DISPUTED"],
  REFUND_REQUESTED: ["REFUNDED", "MANUAL_REVIEW", "DISPUTED"],
  REFUNDED: [],
  CANCELLED: ["REFUNDED"],
  DISPUTED: ["REFUNDED", "MANUAL_REVIEW", "DELIVERED"],
  FAILED: ["MANUAL_REVIEW", "REFUND_REQUESTED", "CANCELLED"],
};

export const TERMINAL_STATES: OrderState[] = ["REFUNDED"];

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransition extends Error {
  readonly orderId: string;
  readonly from: OrderState;
  readonly to: OrderState;
  constructor(orderId: string, from: OrderState, to: OrderState) {
    super(`Invalid order transition ${from} -> ${to} for ${orderId}`);
    this.orderId = orderId;
    this.from = from;
    this.to = to;
  }
}

/** Persist a transition atomically (state + history row). Returns the new state. */
export function transitionOrder(
  db: Db,
  orderId: string,
  to: OrderState,
  actor: string,
  reason?: string,
  data?: unknown,
): OrderState {
  return db.transaction(() => {
    const row = db.get<{ state: OrderState }>("SELECT state FROM orders WHERE id=?", [orderId]);
    if (!row) throw new Error(`Order not found: ${orderId}`);
    const from = row.state;
    if (from === to) return to; // idempotent
    if (!canTransition(from, to)) throw new InvalidTransition(orderId, from, to);
    const ts = nowIso();
    const extra: Record<string, string> = {};
    if (to === "PAID") extra.paid_at = ts;
    if (to === "SHIPPED") extra.shipped_at = ts;
    if (to === "DELIVERED") extra.delivered_at = ts;
    const setCols = ["state=?", "updated_at=?", ...Object.keys(extra).map((k) => `${k}=?`)].join(",");
    db.run(`UPDATE orders SET ${setCols} WHERE id=?`, [to, ts, ...Object.values(extra), orderId]);
    insert(db, "order_transitions", {
      order_id: orderId,
      from_state: from,
      to_state: to,
      actor,
      reason: reason ?? null,
      data: data === undefined ? null : JSON.stringify(data),
      created_at: ts,
    });
    return to;
  });
}
