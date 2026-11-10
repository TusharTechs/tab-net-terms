import { type Cents, max0, min } from "./money.js";

/**
 * TAB credit engine. Pure and deterministic: same inputs, same decision. No model, no I/O.
 *
 * Exposure rule: everything a buyer owes (outstanding) is collected later by pulling from
 * that buyer's Metal debit mandate, so total exposure may never exceed what the supplier
 * can still pull (mandate headroom) or what the buyer's account actually holds.
 */

export type Terms = "PREPAY" | "NET_7" | "NET_30";

/** What the supplier can see of the buyer's mandate (`mandate status` + the credential it issued). */
export interface MandateView {
  payees: string[];
  budget: Cents;
  spent: Cents;
  revoked: boolean;
  expiresAt?: Date;
}

/** One of the buyer's past invoices, as read from T:0. */
export interface InvoiceRecord {
  id: string;
  amount: Cents;
  dueDate: Date;
  paidAt?: Date;
}

export interface BuyerSnapshot {
  buyerId: string;
  /** The supplier's own payee address; the mandate must name it. */
  supplierPayee: string;
  mandate?: MandateView;
  /** Buyer account's USDZ balance on Metal, if read. */
  onchainBalance?: Cents;
  invoices: InvoiceRecord[];
  /** Successful passkey-approved VIC payments from this buyer. */
  vicSettledCount: number;
  /** Unpaid tab balance the buyer owes the supplier now. */
  outstanding: Cents;
}

export interface CreditPolicy {
  /** Days past due before an unpaid invoice counts as overdue. */
  graceDays: number;
  net7Limit: Cents;
  net30Limit: Cents;
  net30MinOnTimeInvoices: number;
  /** 0..1 */
  net30MinOnTimeRate: number;
  /** A buyer must have settled at least one VIC payment before getting credit. */
  requireVicBeforeCredit: boolean;
  /**
   * When the buyer's human lowers the mandate budget, or terms fall to PREPAY, collect everything
   * outstanding at once. Any other drop in the limit (a balance dip, a lower policy cap) collects only the excess.
   */
  collectAllOnTightening: boolean;
}

export const DEFAULT_POLICY: CreditPolicy = {
  graceDays: 3,
  net7Limit: 30_000, // $300
  net30Limit: 90_000, // $900
  net30MinOnTimeInvoices: 3,
  net30MinOnTimeRate: 0.9,
  requireVicBeforeCredit: true,
  collectAllOnTightening: true,
};

export type ReasonCode =
  | "NO_MANDATE"
  | "MANDATE_REVOKED"
  | "MANDATE_EXPIRED"
  | "SUPPLIER_NOT_PAYEE"
  | "OVERDUE_INVOICE"
  | "NO_VIC_HISTORY"
  | "NET_30_EARNED"
  | "NET_7_DEFAULT"
  | "LIMIT_BY_TERMS_CAP"
  | "LIMIT_BY_MANDATE_HEADROOM"
  | "LIMIT_BY_ONCHAIN_BALANCE"
  | "LIMIT_TIGHTENED"
  | "DEMOTED_TO_PREPAY"
  | "COLLECT_EXCESS"
  | "COLLECT_ALL"
  | "ESCALATE_UNCOLLECTABLE";

export interface Reason {
  code: ReasonCode;
  detail: string;
}

export interface CreditDecision {
  buyerId: string;
  terms: Terms;
  /** Maximum total exposure (outstanding + new orders on tab). */
  limit: Cents;
  /** limit − outstanding, floored at 0: what new orders can still go on the tab. */
  available: Cents;
  /** Amount to pull from the mandate right now. */
  collectNow: Cents;
  /** The most a collection may pull now (mandate headroom and the buyer's balance). Whole orders may round a collection up to it. */
  collectMax?: Cents;
  /** Amount owed that the mandate cannot cover; goes to a person. */
  escalate: Cents;
  reasons: Reason[];
}

export interface PreviousDecision {
  terms: Terms;
  limit: Cents;
  /** The mandate budget the buyer's human had signed at that decision. */
  budget?: Cents;
}

const DAY_MS = 86_400_000;
const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;

export function evaluateCredit(
  buyer: BuyerSnapshot,
  now: Date,
  policy: CreditPolicy = DEFAULT_POLICY,
  previous?: PreviousDecision,
): CreditDecision {
  const reasons: Reason[] = [];
  const m = buyer.mandate;

  // 1. Is there a mandate the supplier can actually pull from?
  let mandateUsable = false;
  if (!m) reasons.push({ code: "NO_MANDATE", detail: "buyer has not bound a debit mandate" });
  else if (m.revoked) reasons.push({ code: "MANDATE_REVOKED", detail: "buyer revoked the mandate" });
  else if (m.expiresAt && m.expiresAt.getTime() <= now.getTime())
    reasons.push({ code: "MANDATE_EXPIRED", detail: `mandate expired ${m.expiresAt.toISOString()}` });
  else if (!m.payees.includes(buyer.supplierPayee))
    reasons.push({ code: "SUPPLIER_NOT_PAYEE", detail: "mandate does not name this supplier as payee" });
  else mandateUsable = true;

  const headroom = mandateUsable && m ? max0(m.budget - m.spent) : 0;
  const balanceCap = buyer.onchainBalance ?? Number.POSITIVE_INFINITY;

  // 2. Payment history from T:0.
  const overdue = buyer.invoices
    .filter((i) => !i.paidAt)
    .map((i) => ({ i, days: Math.floor((now.getTime() - i.dueDate.getTime()) / DAY_MS) }))
    .filter((x) => x.days > policy.graceDays)
    .sort((a, b) => b.days - a.days);
  const worst = overdue[0];
  if (worst) reasons.push({ code: "OVERDUE_INVOICE", detail: `${worst.i.id} is ${worst.days} days overdue (${usd(worst.i.amount)})` });

  const paid = buyer.invoices.filter((i) => i.paidAt);
  const onTime = paid.filter((i) => i.paidAt!.getTime() <= i.dueDate.getTime() + policy.graceDays * DAY_MS).length;
  const onTimeRate = paid.length ? onTime / paid.length : 0;

  // 3. Graduation gate: one passkey-approved VIC payment before any credit.
  const vicOk = !policy.requireVicBeforeCredit || buyer.vicSettledCount >= 1;
  if (!vicOk) reasons.push({ code: "NO_VIC_HISTORY", detail: "no settled VIC payment yet; prepay first" });

  // 4. Terms and limit.
  let terms: Terms = "PREPAY";
  let limit: Cents = 0;
  if (mandateUsable && !worst && vicOk) {
    const earned = onTime >= policy.net30MinOnTimeInvoices && onTimeRate >= policy.net30MinOnTimeRate;
    terms = earned ? "NET_30" : "NET_7";
    reasons.push(
      earned
        ? { code: "NET_30_EARNED", detail: `${onTime}/${paid.length} invoices paid on time` }
        : { code: "NET_7_DEFAULT", detail: `${onTime}/${paid.length} on time; net-30 needs ${policy.net30MinOnTimeInvoices} at ≥${policy.net30MinOnTimeRate * 100}%` },
    );
    const cap = earned ? policy.net30Limit : policy.net7Limit;
    limit = min(cap, headroom, balanceCap);
    if (limit === cap) reasons.push({ code: "LIMIT_BY_TERMS_CAP", detail: `${terms} cap ${usd(cap)}` });
    else if (limit === headroom) reasons.push({ code: "LIMIT_BY_MANDATE_HEADROOM", detail: `mandate headroom ${usd(headroom)}` });
    else reasons.push({ code: "LIMIT_BY_ONCHAIN_BALANCE", detail: `buyer balance ${usd(limit)}` });
  }

  const tightened = previous !== undefined && limit < previous.limit;
  const demoted = previous !== undefined && previous.terms !== "PREPAY" && terms === "PREPAY";
  // The buyer's human signed a smaller mandate: they are taking the line back.
  const mandateCut = previous?.budget !== undefined && m !== undefined && m.budget < previous.budget;
  if (demoted) reasons.push({ code: "DEMOTED_TO_PREPAY", detail: `was ${previous!.terms}` });
  else if (tightened) reasons.push({ code: "LIMIT_TIGHTENED", detail: `${usd(previous!.limit)} → ${usd(limit)}${mandateCut ? ` (the buyer's human lowered the mandate to ${usd(m!.budget)})` : ""}` });

  // 5. Collection. Never pull more than headroom or the buyer's balance.
  let collectNow: Cents = 0;
  let escalate: Cents = 0;
  if (buyer.outstanding > 0) {
    const collectAll = policy.collectAllOnTightening && (demoted || (tightened && mandateCut));
    const want = collectAll ? buyer.outstanding : max0(buyer.outstanding - limit);
    if (want > 0) {
      reasons.push(
        collectAll
          ? { code: "COLLECT_ALL", detail: `collect ${usd(want)} now` }
          : { code: "COLLECT_EXCESS", detail: `${usd(want)} over the limit` },
      );
      collectNow = mandateUsable ? min(want, headroom, balanceCap) : 0;
      escalate = want - collectNow;
      if (escalate > 0) reasons.push({ code: "ESCALATE_UNCOLLECTABLE", detail: `${usd(escalate)} cannot be pulled; send to a person` });
    }
  }

  const collectMax = mandateUsable ? min(headroom, balanceCap) : 0;
  return { buyerId: buyer.buyerId, terms, limit, available: max0(limit - buyer.outstanding), collectNow, collectMax, escalate, reasons };
}

/** Largest single VIC payment the Airi test card allows (US$200). Orders above it are never split. */
export const VIC_MAX_PER_TXN: Cents = 20_000;

export type OrderRoute =
  | { kind: "ON_TAB" }
  | { kind: "PREPAY_VIC" }
  /** A short tab secured by a Visa authorisation; captured (undisputed amount only) at the due date. */
  | { kind: "CARD_AUTH" }
  | { kind: "PREPAY_INVOICE"; reason: "OVER_VIC_CAP" };

/** Where a new order goes, given the buyer's current decision. Never splits an order. */
export function routeOrder(decision: CreditDecision, amount: Cents): OrderRoute {
  if (decision.terms !== "PREPAY" && amount <= decision.available) return { kind: "ON_TAB" };
  return amount <= VIC_MAX_PER_TXN ? { kind: "PREPAY_VIC" } : { kind: "PREPAY_INVOICE", reason: "OVER_VIC_CAP" };
}
