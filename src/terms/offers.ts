import type { CreditDecision } from "../domain/credit.js";
import { VIC_MAX_PER_TXN } from "../domain/credit.js";
import type { Cents } from "../domain/money.js";

/**
 * Northwind's catalogue and the payment options it offers a buyer agent. Pure code: prices,
 * discounts, due dates and eligibility are computed here, never by a model.
 */

export interface Product {
  id: string;
  name: string;
  /** Price per unit in cents (may be < 100: 4 = 4¢ per query). */
  unitPrice: Cents;
  unit: string;
  priceRoute: string;
  maxUnits: number;
}

export const CATALOG: Product[] = [
  { id: "mkt-queries", name: "Market data queries", unitPrice: 4, unit: "query", priceRoute: "/v2/query", maxUnits: 5_000 },
  { id: "fx-backfill", name: "FX tick backfill", unitPrice: 1_200, unit: "1,000 rows", priceRoute: "/v2/backfill", maxUnits: 15 },
  { id: "sla-day", name: "Priority SLA", unitPrice: 2_500, unit: "day", priceRoute: "/v2/sla", maxUnits: 10 },
];

export type PaymentOption = "prepay_card" | "card_net_7" | "net_7" | "net_30" | "pay_in_10_discount";

export interface OptionQuote {
  option: PaymentOption;
  /** What the buyer will pay, in cents. */
  amount: Cents;
  /** Days until payment is due (0 = now). */
  dueInDays: number;
  /** Discount off list, as a fraction (0.02 = 2%). */
  discount: number;
  /** For the early-pay option: the annualised return of taking the discount vs paying at day 30. */
  annualisedReturn?: number;
  description: string;
}

export interface Offer {
  productId: string;
  units: number;
  listAmount: Cents;
  options: OptionQuote[];
  /** Why some options are missing (e.g. over available credit). */
  notes: string[];
}

/** The supplier's sales terms. Set by the CFO's signed policy; defaults below. */
export interface SalesTerms {
  /** Early-pay discount: `discount` off list if collected within `days`. */
  earlyPay: { days: number; discount: number };
}

export const DEFAULT_TERMS: SalesTerms = { earlyPay: { days: 10, discount: 0.02 } };
export const EARLY_PAY = DEFAULT_TERMS.earlyPay;
/** Card-secured tab: kept short so the capture falls well inside the card authorisation's hold. */
export const CARD_TAB_DAYS = 7;
export const NET_DAYS = 30;

/** Annualised return of taking a d% discount for paying (net - early) days sooner. */
export function discountYield(discount: number, earlyDays: number, netDays: number): number {
  return (discount / (1 - discount)) * (365 / (netDays - earlyDays));
}

export function quote(productId: string, units: number, decision: CreditDecision, terms: SalesTerms = DEFAULT_TERMS): Offer {
  const early = terms.earlyPay;
  const p = CATALOG.find((x) => x.id === productId);
  if (!p) throw new Error(`unknown product ${productId}`);
  if (!Number.isInteger(units) || units < 1 || units > p.maxUnits) throw new Error(`units must be 1..${p.maxUnits}`);
  const listAmount = p.unitPrice * units;
  const options: OptionQuote[] = [];
  const notes: string[] = [];

  if (listAmount <= VIC_MAX_PER_TXN) {
    options.push({ option: "prepay_card", amount: listAmount, dueInDays: 0, discount: 0, description: "Pay now with your Visa credential (passkey-approved)" });
  } else {
    notes.push("prepay by card unavailable: over the $200 per-transaction card cap (orders are never split)");
  }

  if (decision.terms === "PREPAY") {
    notes.push(`no credit terms: ${decision.reasons.map((r) => r.detail).join("; ")}`);
    // The on-ramp: a buyer with no Metal terms yet (and nothing overdue) can still pay later, because
    // a passkey-approved Visa authorisation secures the tab. Only the undisputed amount is captured.
    const overdue = decision.reasons.some((r) => r.code === "OVERDUE_INVOICE");
    if (listAmount <= VIC_MAX_PER_TXN && !overdue) {
      options.push({ option: "card_net_7", amount: listAmount, dueInDays: CARD_TAB_DAYS, discount: 0, description: `On a ${CARD_TAB_DAYS}-day tab secured now by a Visa authorisation (passkey-approved); at the due date only the undisputed amount is captured` });
    }
  } else if (listAmount > decision.available) {
    notes.push(`over available credit ($${(decision.available / 100).toFixed(2)} available)`);
  } else if (decision.terms === "NET_7") {
    options.push({ option: "net_7", amount: listAmount, dueInDays: 7, discount: 0, description: "On your tab, due in 7 days (net-30 is earned with on-time history)" });
  } else {
    options.push({ option: "net_30", amount: listAmount, dueInDays: NET_DAYS, discount: 0, description: `On your tab, due in ${NET_DAYS} days, collected from your debit mandate` });
    const discounted = Math.round(listAmount * (1 - early.discount));
    options.push({
      option: "pay_in_10_discount",
      amount: discounted,
      dueInDays: early.days,
      discount: early.discount,
      annualisedReturn: discountYield(early.discount, early.days, NET_DAYS),
      description: `On your tab at ${+(early.discount * 100).toFixed(2)}% off if collected in ${early.days} days`,
    });
  }
  return { productId, units, listAmount, options, notes };
}

/** The buyer's own human-set rules, enforced in code on the buyer side before any order is sent. */
export interface BuyerPolicy {
  maxOrder: Cents;
  monthlyBudget: Cents;
  /** Annual cost of capital, e.g. 0.12. Informational for the agent; the desk never uses it. */
  costOfCapital: number;
}

export function checkBuyerPolicy(policy: BuyerPolicy, spentThisMonth: Cents, amount: Cents): string | null {
  if (amount > policy.maxOrder) return `order $${(amount / 100).toFixed(2)} exceeds your max order $${(policy.maxOrder / 100).toFixed(2)}`;
  if (spentThisMonth + amount > policy.monthlyBudget) return `order would exceed your monthly budget ($${((policy.monthlyBudget - spentThisMonth) / 100).toFixed(2)} left)`;
  return null;
}
