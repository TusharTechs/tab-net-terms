import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Books } from "../books/books.js";
import { type CreditDecision, type CreditPolicy, DEFAULT_POLICY, evaluateCredit, type OrderRoute, type PreviousDecision, routeOrder } from "../domain/credit.js";
import type { Cents } from "../domain/money.js";
import type { DisputeDecision, OrderEvidence } from "../disputes/decide.js";
import type { MandateStatus, PullOutcome } from "../metal/agent.js";
import { type DeskPolicy, policyHash, type SignedPolicy, verifyPolicy } from "../policy/policy.js";
import { CATALOG, DEFAULT_TERMS, type PaymentOption, quote, type SalesTerms } from "../terms/offers.js";

/**
 * The supplier's desk: it takes agent orders, keeps each buyer's tab, re-evaluates credit
 * from live mandate state + on-chain balance + books, and collects by pulling from the
 * buyer's mandate. Every decision is appended to an event log the demo screen reads.
 */

export interface Order {
  id: string;
  amount: Cents;
  description: string;
  placedAt: string;
  route: OrderRoute["kind"];
  /** Set once a pull collected it ("credit:<noteId>" when fully covered by credit). */
  collectedBy?: string;
  /** Pricing and delivery facts used to settle disputes. */
  priceRoute?: string;
  unitPrice?: Cents;
  units?: number;
  /** Units the supplier's own delivery QA flagged as stale. */
  staleUnits?: number;
  /** Credit notes applied to this order while still uncollected. */
  credited?: Cents;
  /** Agent orders: what was bought and on which terms. */
  productId?: string;
  option?: PaymentOption;
  /** When payment is due (ISO). Net-30 / pay-in-10 orders. */
  dueAt?: string;
  /** Discount off list taken for early payment (fraction). */
  discount?: number;
  /** Card-secured tab: the Visa authorisation that guarantees it, and what was captured at due. */
  card?: { paymentIntentId: string; airiMandateId: string; statementId: string; authorised: Cents; captured?: Cents };
}

/** What the buyer still owes on an order. */
export const dueOn = (o: Order): Cents => o.amount - (o.credited ?? 0);

export interface Buyer {
  id: string;
  name: string;
  /** Buyer's Metal account (mandate principal). */
  account: string;
  /** Current supplier-issued credential bound by the buyer. */
  credential?: string;
  mandateKeyFile?: string;
  vicSettledCount: number;
  orders: Order[];
  previous?: PreviousDecision;
  /** Credit owed to the buyer on orders already collected; netted off the next collection. */
  creditBalance?: Cents;
  /**
   * A pull sent but not yet known paid or refused (Metal answered pending/held, or the process
   * died mid-call). It is resolved by re-sending the SAME pull (same payment-id, amount and original
   * credential), which Metal pays at most once, before any new batch is built.
   */
  inflight?: {
    paymentId: string; orderIds: string[]; amount: Cents; creditApplied: Cents; credential: string; mandateKeyFile: string;
    /** The mandate's spent total just before the first send: if it has since risen by `amount`, the pull went through. */
    spentBefore?: Cents;
    /** The tx Metal reported for a pending pull, if any. */
    tx?: string;
  };
  /** Statements issued as their own Metal mandates (the statement IS the mandate). */
  statements?: Statement[];
  /** Airwallex payment intents already counted toward terms (each counts once). */
  vicPaymentIds?: string[];
}

/**
 * A statement issued as its own Metal mandate: cap = budget = total, collectible once, only
 * between its due time and the end of grace. The buyer's owner binding it is the acceptance;
 * the chain refuses early, oversized, repeat or late collections and the desk records each refusal.
 */
export interface Statement {
  id: string;
  orderIds: string[];
  total: Cents;
  dueAt: string;
  graceEndsAt: string;
  /** sha256 of the statement's orders and amounts; also the collection's payment-id. */
  hash: string;
  credential: string;
  mandateKeyFile: string;
  mandateId: string;
  acceptTx: string;
  status: "accepted" | "collected" | "unpaid";
  collectedTx?: string;
  /** Credits issued on its orders after it was bound: its mandate still collects the bound total, so they are owed back. */
  creditCarried?: Cents;
  refusals: { reason: string; tx?: string; at: string }[];
}

export interface DeskEvent {
  seq: number;
  at: string;
  buyerId: string;
  type: "order" | "decision" | "collect" | "collect_refused" | "escalate" | "credit" | "dispute" | "vic" | "mandate" | "books" | "settle" | "agent" | "refused" | "statement" | "proof" | "policy";
  summary: string;
  data: Record<string, unknown>;
}

export interface DeskState {
  buyers: Record<string, Buyer>;
  events: DeskEvent[];
  /** The CFO's signed policy in force (defaults when absent). */
  policy?: SignedPolicy;
}

/** One buyer's credit before and after a proposed policy, without acting on it. */
export interface PolicyDiffRow {
  buyerId: string;
  name: string;
  before: { terms: string; limit: Cents };
  after: { terms: string; limit: Cents };
  outstanding: Cents;
  /** What the desk would collect at once if this policy were applied now. */
  wouldCollect: Cents;
}

export interface DeskDeps {
  supplierPayee: string;
  /** Funded supplier key that pays gas to record refused statement collections on chain. */
  refusalKey?: string;
  metal: {
    status(credential: string): Promise<MandateStatus>;
    pull(p: { credential: string; mandateKeyFile: string; to: string; amount: Cents; paymentId: string; recordRefusalKey?: string }): Promise<PullOutcome>;
  };
  balanceOf(address: string): Promise<Cents>;
  books: Books;
  now(): Date;
  /** Finds a USDZ transfer from the buyer to the supplier of exactly `amount` on chain (recent blocks), skipping txs already on record. */
  findTransfer?(p: { from: string; to: string; amount: Cents; exclude?: string[] }): Promise<string | null>;
  /** Reads a payment intent from Airwallex, so the VIC gate verifies rather than trusts. */
  readPaymentIntent?(id: string): Promise<{ status: string; amount?: number; captured_amount?: number; merchant_order_id?: string; metadata?: Record<string, string> }>;
  policy?: CreditPolicy;
  /** Public key file of the CFO's policy key: the desk applies (and keeps using) only policies that verify under it. */
  policyPublicKey?: string;
  persist?(state: DeskState): void;
}

const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;
const openOrders = (b: Buyer) => b.orders.filter((o) => o.route === "ON_TAB" && !o.collectedBy);
/** Orders an accepted statement will collect: the credit-line mandate must not pull them too. */
const onAcceptedStatement = (b: Buyer) => new Set((b.statements ?? []).filter((st) => st.status === "accepted").flatMap((st) => st.orderIds));
const lineCollectable = (b: Buyer) => { const covered = onAcceptedStatement(b); return openOrders(b).filter((o) => !covered.has(o.id)); };
/** Whole orders, oldest first, until at least `amount` (net of credit) is covered, never past `max`. */
function pickBatch(b: Buyer, amount: Cents, max: Cents): { batch: Order[]; gross: Cents; applied: Cents; net: Cents } {
  const credit = b.creditBalance ?? 0;
  const batch: Order[] = [];
  let gross = 0;
  for (const o of lineCollectable(b)) {
    if (gross - credit >= amount) break;
    if (gross + dueOn(o) - credit > max) break;
    batch.push(o);
    gross += dueOn(o);
  }
  const applied = Math.min(credit, gross);
  return { batch, gross, applied, net: gross - applied };
}
const outstandingOf = (b: Buyer) => Math.max(0, openOrders(b).reduce((s, o) => s + dueOn(o), 0) - (b.creditBalance ?? 0));

/** Payment-id for a collection: hash of exactly which orders (and amounts) it pays for, and any credit netted off. */
export function batchPaymentId(buyerId: string, orders: Pick<Order, "id" | "amount">[], creditApplied: Cents = 0): string {
  const canonical = JSON.stringify(creditApplied ? { buyerId, orders: orders.map((o) => [o.id, o.amount]), creditApplied } : { buyerId, orders: orders.map((o) => [o.id, o.amount]) });
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

export class Desk {
  /** The stored policy, only if it verified when the desk loaded it (or when it was applied). */
  private trustedPolicy: SignedPolicy | undefined;

  constructor(
    readonly state: DeskState,
    private readonly deps: DeskDeps,
  ) {
    if (state.policy) {
      if (this.verifies(state.policy)) this.trustedPolicy = state.policy;
      else this.emit("desk", "refused", `stored policy ${state.policy.hash.slice(0, 12)}… does not verify under the CFO's key: using the default policy`, { hash: state.policy.hash });
    }
  }

  private verifies(s: SignedPolicy): boolean {
    try {
      return Boolean(this.deps.policyPublicKey) && verifyPolicy(s, this.deps.policyPublicKey!);
    } catch {
      return false;
    }
  }

  private emit(buyerId: string, type: DeskEvent["type"], summary: string, data: Record<string, unknown> = {}) {
    this.state.events.push({ seq: this.state.events.length + 1, at: this.deps.now().toISOString(), buyerId, type, summary, data });
    this.deps.persist?.(this.state);
  }

  private buyer(id: string): Buyer {
    const b = this.state.buyers[id];
    if (!b) throw new Error(`unknown buyer ${id}`);
    return b;
  }

  /**
   * Re-reads mandate, balance and books, decides, and collects if the decision says so.
   * After a collection it re-reads once, so the log (and the screen) shows the state after the pull.
   */
  /** Which buyer (if any) a Visa payment has already counted for. A payment earns terms once, for one buyer. */
  private vicCountedFor(paymentIntentId: string): string | undefined {
    return Object.values(this.state.buyers).find((x) => (x.vicPaymentIds ?? []).includes(paymentIntentId))?.id;
  }

  /** The credit policy in force: the CFO's signed policy, else the configured default. */
  creditPolicy(): CreditPolicy {
    return this.trustedPolicy?.policy.credit ?? this.deps.policy ?? DEFAULT_POLICY;
  }

  salesTerms(): SalesTerms {
    return this.trustedPolicy?.policy.terms ?? DEFAULT_TERMS;
  }

  private async inputsFor(b: Buyer) {
    const mandate = b.credential ? await this.deps.metal.status(b.credential) : undefined;
    const [balance, invoices] = await Promise.all([this.deps.balanceOf(b.account), this.deps.books.invoicesFor(b.id)]);
    return { mandate, balance, invoices, input: { buyerId: b.id, supplierPayee: this.deps.supplierPayee, ...(mandate ? { mandate } : {}), onchainBalance: balance, invoices, vicSettledCount: b.vicSettledCount, outstanding: outstandingOf(b) } };
  }

  async evaluate(buyerId: string, afterCollect = false): Promise<CreditDecision> {
    const b = this.buyer(buyerId);
    // A pull still in flight is settled first, every time: from the chain if it landed, else re-sent as the same pull.
    if (b.inflight && !afterCollect) await this.resolveInflight(b);
    const { mandate, balance, invoices, input } = await this.inputsFor(b);
    const decision = evaluateCredit(input, this.deps.now(), this.creditPolicy(), b.previous);
    const summary = `${decision.terms} · limit ${usd(decision.limit)} · available ${usd(decision.available)}`;
    const lastDecision = [...this.state.events].reverse().find((e) => e.buyerId === b.id && e.type === "decision");
    // Log again whenever the reasons change (e.g. a mandate was bound but terms are still prepay), so the screen never shows stale reasons.
    const reasonsKey = (r: { code: string; detail: string }[]) => r.map((x) => `${x.code}:${x.detail}`).join("|");
    const lastReasons = (lastDecision?.data as { decision?: { reasons?: { code: string; detail: string }[] } } | undefined)?.decision?.reasons ?? [];
    const unchanged = lastDecision?.summary === summary && reasonsKey(lastReasons) === reasonsKey(decision.reasons) && decision.collectNow === 0 && decision.escalate === 0;
    if (!unchanged) this.emit(b.id, "decision", summary, {
      decision,
      inputs: { mandate: mandate && { id: mandate.mandateId, budget: mandate.budget, spent: mandate.spent, revoked: mandate.revoked }, balance, booksSource: this.deps.books.sourceFor?.(b.id) ?? this.deps.books.source, invoices: invoices.length },
    });
    b.previous = { terms: decision.terms, limit: decision.limit, ...(mandate ? { budget: mandate.budget } : {}) };

    let collected = false;
    if (decision.collectNow > 0 && b.credential && b.mandateKeyFile) collected = await this.collect(b, decision.collectNow, decision.collectMax ?? decision.collectNow);
    if (decision.escalate > 0) this.emit(b.id, "escalate", `${usd(decision.escalate)} cannot be pulled from the mandate; sent to a person`, { amount: decision.escalate });
    this.deps.persist?.(this.state);
    if (collected && !afterCollect) return this.evaluate(buyerId, true);
    return decision;
  }

  /**
   * Collects at least `amount` (net of any credit owed to the buyer) in whole orders, oldest first,
   * never pulling more than `max` (mandate headroom and balance). The payment-id names exactly those
   * orders and the credit applied.
   */
  private async collect(b: Buyer, amount: Cents, max: Cents = amount): Promise<boolean> {
    if (b.inflight) return this.resolveInflight(b);
    const credit = b.creditBalance ?? 0;
    const { batch, applied, net } = pickBatch(b, amount, max);
    if (batch.length === 0) return false;
    const paymentId = batchPaymentId(b.id, batch.map((o) => ({ id: o.id, amount: dueOn(o) })), applied);

    if (net === 0) {
      for (const o of batch) o.collectedBy = `credit:${paymentId.slice(0, 18)}`;
      b.creditBalance = credit - applied;
      this.emit(b.id, "collect", `${batch.length} order(s) settled entirely from credit (${usd(applied)})`, { paymentId, orders: batch.map((o) => o.id), amount: 0, creditApplied: applied });
      return true;
    }
    // Record the pull BEFORE sending it, with the mandate's spent total, so a crash or a pending answer can only
    // ever be reconciled from the chain or retried as this same pull.
    const spentBefore = (await this.deps.metal.status(b.credential!)).spent;
    b.inflight = { paymentId, orderIds: batch.map((o) => o.id), amount: net, creditApplied: applied, credential: b.credential!, mandateKeyFile: b.mandateKeyFile!, spentBefore };
    this.deps.persist?.(this.state);
    return this.resolveInflight(b);
  }

  /** Sends (or re-sends) the in-flight pull and applies its outcome. Paid/refused clear it; pending/held keep it. */
  private async resolveInflight(b: Buyer): Promise<boolean> {
    const p = b.inflight!;
    // Before any (re-)send: if the mandate's spent total already rose by this pull, it went through (the
    // answer was lost). Take it from the chain and never send it again.
    if (p.spentBefore !== undefined) {
      const now = await this.deps.metal.status(p.credential);
      if (now.spent >= p.spentBefore + p.amount) {
        const known = this.state.events.filter((e) => e.type === "collect" && e.data.tx).map((e) => String(e.data.tx));
        const tx = p.tx ?? (await this.deps.findTransfer?.({ from: b.account, to: this.deps.supplierPayee, amount: p.amount, exclude: known })) ?? null;
        if (!tx) {
          this.emit(b.id, "escalate", `pull of ${usd(p.amount)} went through on the mandate (spent ${usd(p.spentBefore)} → ${usd(now.spent)}) but its tx was not found: not re-sending; a person reconciles it`, { paymentId: p.paymentId, amount: p.amount });
          this.deps.persist?.(this.state);
          return false;
        }
        return this.markInflightPaid(b, tx, "reconciled from the chain, nothing re-sent");
      }
    }
    const res = await this.deps.metal.pull({ credential: p.credential, mandateKeyFile: p.mandateKeyFile, to: this.deps.supplierPayee, amount: p.amount, paymentId: p.paymentId });
    if (res.outcome === "paid") return this.markInflightPaid(b, res.tx, res.alreadyPaid ? "already paid earlier" : undefined);
    if (res.outcome === "refused") {
      delete b.inflight;
      this.emit(b.id, "collect_refused", `pull of ${usd(p.amount)} refused: ${res.reason}`, { reason: res.reason, detail: res.detail, paymentId: p.paymentId, amount: p.amount });
    } else {
      if (res.tx) p.tx = res.tx;
      this.emit(b.id, "collect_refused", `pull of ${usd(p.amount)} ${res.outcome}; will re-check the chain before re-sending the same pull`, { outcome: res.outcome, paymentId: p.paymentId, amount: p.amount, ...(res.tx ? { pendingTx: res.tx } : {}) });
    }
    this.deps.persist?.(this.state);
    return false;
  }

  /** The in-flight pull is known paid (by Metal's answer or from the chain): mark its orders collected. */
  private markInflightPaid(b: Buyer, tx: string, note?: string): boolean {
    const p = b.inflight!;
    const batch = b.orders.filter((o) => p.orderIds.includes(o.id));
    for (const o of batch) o.collectedBy = tx;
    b.creditBalance = (b.creditBalance ?? 0) - p.creditApplied;
    delete b.inflight;
    const creditNote = p.creditApplied ? ` after ${usd(p.creditApplied)} credit` : "";
    this.emit(b.id, "collect", `collected ${usd(p.amount)} for ${batch.length} order(s)${creditNote}${note ? ` (${note})` : ""}`, { tx, paymentId: p.paymentId, orders: p.orderIds, amount: p.amount, creditApplied: p.creditApplied });
    return true;
  }

  /**
   * The buyer asks to pay its open credit-line tab now (for example, to take the early-pay discount
   * on time). Collected through its mandate like any other pull: in whole orders, never past the
   * mandate's headroom or the buyer's balance, and never orders an accepted statement will collect.
   */
  async payNow(buyerId: string): Promise<boolean> {
    const b = this.buyer(buyerId);
    if (!b.credential || !b.mandateKeyFile) return false;
    if (b.inflight) return this.resolveInflight(b);
    const owed = lineCollectable(b).reduce((s, o) => s + dueOn(o), 0) - (b.creditBalance ?? 0);
    if (owed <= 0) return false;
    const m = await this.deps.metal.status(b.credential);
    const max = Math.min(Math.max(0, m.budget - m.spent), await this.deps.balanceOf(b.account));
    this.emit(b.id, "order", `${b.name} asks to pay its tab now: ${usd(owed)}`, { payNow: owed });
    const ok = await this.collect(b, owed, max);
    this.deps.persist?.(this.state);
    return ok;
  }

  /** An agent order arrives. It goes on the tab only if it fits; otherwise prepay (VIC ≤ $200, else invoice). */
  async placeOrder(
    buyerId: string,
    order: { id: string; amount: Cents; description: string } & Partial<Pick<Order, "priceRoute" | "unitPrice" | "units" | "staleUnits">>,
  ): Promise<OrderRoute> {
    const b = this.buyer(buyerId);
    const decision = await this.evaluate(buyerId);
    const route = routeOrder(decision, order.amount);
    b.orders.push({ ...order, placedAt: this.deps.now().toISOString(), route: route.kind });
    const where = route.kind === "ON_TAB" ? "on the tab" : route.kind === "PREPAY_VIC" ? "prepay by VIC card" : "prepay by invoice (over the $200 VIC cap)";
    this.emit(b.id, "order", `${order.id} ${usd(order.amount)} → ${where}`, { order, route });
    return route;
  }

  /** What Northwind offers this buyer for this order right now (fresh credit decision, code-priced). */
  async offerFor(buyerId: string, productId: string, units: number) {
    const decision = await this.evaluate(buyerId);
    const cardOpen = this.buyer(buyerId).orders.filter((o) => o.route === "CARD_AUTH" && !o.collectedBy).reduce((s, o) => s + dueOn(o), 0);
    return quote(productId, units, decision, this.salesTerms(), { cardOpen });
  }

  /**
   * An agent's order with its chosen payment option. The choice is re-checked against a fresh,
   * code-computed offer: anything not on offer is refused, whatever the agent says.
   */
  async placeAgentOrder(
    buyerId: string,
    req: { productId: string; units: number; option: PaymentOption; note?: string; staleUnits?: number },
  ): Promise<{ ok: true; orderId: string; amount: Cents; dueAt: string | null; route: Order["route"] } | { ok: false; reason: string }> {
    const b = this.buyer(buyerId);
    let offer;
    try {
      offer = await this.offerFor(buyerId, req.productId, req.units);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.emit(b.id, "refused", `order refused: ${reason}`, { req });
      return { ok: false, reason };
    }
    const chosen = offer.options.find((o) => o.option === req.option);
    if (!chosen) {
      const reason = `option "${req.option}" is not on offer for this order${offer.notes.length ? ` (${offer.notes.join("; ")})` : ""}`;
      this.emit(b.id, "refused", `order refused: ${reason}`, { req, offered: offer.options.map((o) => o.option) });
      return { ok: false, reason };
    }
    const p = CATALOG.find((x) => x.id === req.productId)!;
    const now = this.deps.now();
    const id = `ord-${now.getTime().toString(36)}-${b.orders.length + 1}`;
    const dueAt = chosen.dueInDays > 0 ? new Date(now.getTime() + chosen.dueInDays * 86_400_000).toISOString() : null;
    const route: Order["route"] = chosen.option === "prepay_card" ? "PREPAY_VIC" : chosen.option === "card_net_7" ? "CARD_AUTH" : "ON_TAB";
    const order: Order = {
      id, amount: chosen.amount, description: `${p.name} · ${req.units} ${p.unit}`, placedAt: now.toISOString(), route,
      productId: p.id, units: req.units, unitPrice: p.unitPrice, priceRoute: p.priceRoute, option: chosen.option, discount: chosen.discount,
      ...(dueAt ? { dueAt } : {}), ...(req.staleUnits !== undefined ? { staleUnits: req.staleUnits } : {}),
    };
    b.orders.push(order);
    const terms = chosen.option === "prepay_card" ? "prepay by Visa card" : chosen.option === "card_net_7" ? `${chosen.dueInDays}-day tab secured by a Visa authorisation` : chosen.option === "net_30" ? "net-30 on the tab" : chosen.option === "net_7" ? "net-7 on the tab" : `${chosen.discount * 100}% off, due in ${chosen.dueInDays} days, on the tab`;
    this.emit(b.id, "order", `${id} ${order.description}: ${usd(order.amount)} → ${terms}`, { order, note: req.note ?? null });
    return { ok: true, orderId: id, amount: order.amount, dueAt, route };
  }

  /** Records the result of the "every dollar proven" checks. */
  recordProof(summary: string, checks: unknown[]) {
    this.emit("desk", "proof", summary, { checks });
  }

  /** Records what a buyer agent said about its decision (shown on the screen; never used to decide). */
  recordAgentNote(buyerId: string, text: string, data: Record<string, unknown> = {}) {
    this.emit(buyerId, "agent", text, data);
  }

  /**
   * A credit note. On an order still on the tab it reduces what is owed; on a collected
   * order it becomes credit netted off the buyer's next collection. Never above what was charged.
   */
  applyCredit(buyerId: string, orderId: string, amount: Cents, reason: string, staleUnits?: number): Cents {
    const b = this.buyer(buyerId);
    const o = b.orders.find((x) => x.id === orderId);
    if (!o) throw new Error(`unknown order ${orderId}`);
    if (o.route === "CARD_AUTH" && o.collectedBy) throw new Error(`order ${orderId} was already captured on the card: a refund there needs a person`);
    const room = o.amount - (o.credited ?? 0);
    const applied = Math.max(0, Math.min(amount, room));
    if (applied === 0) return 0;
    o.credited = (o.credited ?? 0) + applied;
    let where = "reduces what is owed on the tab";
    // Anything that will collect the pre-credit amount (a pull in flight, or an accepted statement whose
    // mandate was bound for its total) makes the credit owed back: carry it to the next collection.
    const statement = (b.statements ?? []).find((st) => st.status === "accepted" && st.orderIds.includes(orderId));
    const taken = Boolean(o.collectedBy) || Boolean(b.inflight?.orderIds.includes(orderId)) || Boolean(statement);
    if (taken) {
      b.creditBalance = (b.creditBalance ?? 0) + applied;
      if (statement) statement.creditCarried = (statement.creditCarried ?? 0) + applied;
      where = statement ? `carried to the next collection: statement ${statement.id} was bound for its full total` : "carried to the next collection";
    }
    this.emit(b.id, "credit", `credit note ${usd(applied)} on ${orderId}: ${reason} (${where})`, { orderId, amount: applied, reason, collected: taken, ...(staleUnits !== undefined ? { staleUnits } : {}) });
    return applied;
  }

  /**
   * Open tab orders due on the same UTC day as `dueOnDay` that no statement covers yet, priced net
   * of credits. The statement is due at the latest of their due times, so no order is collected early.
   */
  draftStatement(buyerId: string, dueOnDay: string): { id: string; orderIds: string[]; total: Cents; dueAt: string; hash: string } | null {
    const b = this.buyer(buyerId);
    const day = dueOnDay.slice(0, 10);
    // Orders on any earlier statement, or in a line pull still in flight, are never drafted again.
    const covered = new Set([...(b.statements ?? []).flatMap((st) => st.orderIds), ...(b.inflight?.orderIds ?? [])]);
    const orders = openOrders(b).filter((o) => o.dueAt?.slice(0, 10) === day && !covered.has(o.id));
    if (orders.length === 0) return null;
    const dueAt = orders.map((o) => o.dueAt!).sort().at(-1)!;
    const total = orders.reduce((s, o) => s + dueOn(o), 0);
    const hash = batchPaymentId(b.id, orders.map((o) => ({ id: o.id, amount: dueOn(o) })));
    return { id: `STM-${hash.slice(2, 10).toUpperCase()}`, orderIds: orders.map((o) => o.id), total, dueAt, hash };
  }

  /** The buyer's owner bound the statement mandate: the statement is accepted. */
  recordStatement(buyerId: string, st: Omit<Statement, "status" | "refusals">) {
    const b = this.buyer(buyerId);
    (b.statements ??= []).push({ ...st, status: "accepted", refusals: [] });
    this.emit(b.id, "statement", `statement ${st.id} ${usd(st.total)} for ${st.orderIds.length} order(s) accepted by the buyer on chain: collectible once, from ${st.dueAt.slice(0, 16).replace("T", " ")} until ${st.graceEndsAt.slice(0, 16).replace("T", " ")} UTC`, { statementId: st.id, mandateId: st.mandateId, tx: st.acceptTx, total: st.total });
  }

  /**
   * Collects a statement through its own mandate (payment-id = its hash). The chain enforces the
   * terms: early, repeat, oversized or late attempts are refused, and with a refusal key each
   * refusal is recorded on chain.
   */
  async collectStatement(
    buyerId: string,
    statementId: string,
    /** Fault injection only: a different amount or a fresh payment-id, as a buggy or malicious collector would send. */
    inject: { amount?: Cents; paymentId?: string } = {},
  ): Promise<PullOutcome> {
    const amount = inject.amount;
    const b = this.buyer(buyerId);
    const st = (b.statements ?? []).find((x) => x.id === statementId);
    if (!st) throw new Error(`unknown statement ${statementId}`);
    const injected = inject.amount !== undefined || inject.paymentId !== undefined;
    // A normal collection checks the desk's own record first; only deliberate fault injection reaches the chain regardless.
    if (!injected && st.status === "collected") {
      this.emit(b.id, "collect", `statement ${st.id} was already collected in ${st.collectedTx?.slice(0, 10)}…: answered from the desk's record, nothing sent`, { tx: st.collectedTx, statementId: st.id, paymentId: st.hash, orders: st.orderIds, amount: st.total });
      return { outcome: "paid", tx: st.collectedTx!, alreadyPaid: true, spent: "" };
    }
    if (!injected && st.status === "unpaid") throw new Error(`statement ${st.id} went unpaid; its orders are back on the credit line`);
    const res = await this.deps.metal.pull({
      credential: st.credential, mandateKeyFile: st.mandateKeyFile, to: this.deps.supplierPayee, amount: amount ?? st.total, paymentId: inject.paymentId ?? st.hash,
      ...(this.deps.refusalKey ? { recordRefusalKey: this.deps.refusalKey } : {}),
    });
    if (res.outcome === "paid") {
      if (st.status !== "collected") {
        for (const o of b.orders.filter((x) => st.orderIds.includes(x.id))) o.collectedBy = res.tx;
        st.status = "collected";
        st.collectedTx = res.tx;
      }
      this.emit(b.id, "collect", `statement ${st.id} collected ${usd(amount ?? st.total)} through its own mandate${res.alreadyPaid ? " (already paid earlier)" : ""}`, { tx: res.tx, statementId: st.id, paymentId: st.hash, orders: st.orderIds, amount: amount ?? st.total });
    } else if (res.outcome === "refused") {
      st.refusals.push({ reason: res.reason, ...(res.recordedTx ? { tx: res.recordedTx } : {}), at: this.deps.now().toISOString() });
      this.emit(b.id, "refused", `chain refused collecting statement ${st.id}: ${res.reason}${res.recordedTx ? " (refusal recorded on chain)" : ""}`, { statementId: st.id, reason: res.reason, detail: res.detail, ...(res.recordedTx ? { tx: res.recordedTx } : {}) });
    } else {
      this.emit(b.id, "collect_refused", `statement ${st.id} collection ${res.outcome}`, { statementId: st.id, outcome: res.outcome });
    }
    this.deps.persist?.(this.state);
    return res;
  }

  /** A statement that was not paid in its window: its orders go back to the credit-line backstop. */
  markStatementUnpaid(buyerId: string, statementId: string) {
    const b = this.buyer(buyerId);
    const st = (b.statements ?? []).find((x) => x.id === statementId);
    if (!st || st.status !== "accepted") return;
    if (this.deps.now().getTime() < Date.parse(st.graceEndsAt)) throw new Error(`statement ${st.id} is still inside its window (until ${st.graceEndsAt})`);
    st.status = "unpaid";
    // Its orders go back to the line at their credited amounts, so credit carried for them is no longer owed back.
    if (st.creditCarried) b.creditBalance = Math.max(0, (b.creditBalance ?? 0) - st.creditCarried);
    this.emit(b.id, "escalate", `statement ${st.id} unpaid after grace: ${usd(st.total)} returns to the credit-line mandate`, { statementId: st.id });
    this.deps.persist?.(this.state);
  }

  /** Records a dispute decision (made in code from the order records) and applies its credits. */
  resolveDispute(buyerId: string, decision: DisputeDecision, meta: { summary: string; model?: string }) {
    let credited = 0;
    for (const f of decision.findings) if (f.verdict === "credit" && f.orderId) credited += this.applyCredit(buyerId, f.orderId, f.amount, f.reason, f.units);
    const upheld = decision.findings.filter((f) => f.verdict === "upheld_for_supplier").length;
    const escalated = decision.findings.filter((f) => f.verdict === "escalate").length;
    this.emit(buyerId, "dispute", `dispute resolved: ${usd(credited)} credited, ${upheld} claim(s) declined with the order record as proof, ${escalated} to a person`, { ...meta, findings: decision.findings });
    if (escalated) this.emit(buyerId, "escalate", `${escalated} dispute claim(s) need a person`, { findings: decision.findings.filter((f) => f.verdict === "escalate") });
    this.deps.persist?.(this.state);
  }

  /** A passkey-approved VIC payment from this buyer settled at the supplier's checkout: the on-ramp to credit. */
  /**
   * Counts a passkey-approved VIC payment toward this buyer's terms, but only after reading the
   * payment intent back from Airwallex: it must be SUCCEEDED, captured, and carry the statement's
   * order id and hash. (A merchant cannot tell from the card that it was VIC; the link is the
   * Airi mandate id and statement hash recorded when the statement was paid.)
   */
  async verifyVicPayment(buyerId: string, p: { paymentIntentId: string; airiMandateId: string; statementId: string; statementHash: string }): Promise<boolean> {
    const b = this.buyer(buyerId);
    if (!this.deps.readPaymentIntent) throw new Error("readPaymentIntent dependency missing");
    const pi = await this.deps.readPaymentIntent(p.paymentIntentId);
    const checks = {
      succeeded: pi.status === "SUCCEEDED",
      captured: (pi.captured_amount ?? 0) > 0,
      statement: pi.merchant_order_id === p.statementId,
      hash: (pi.metadata?.statement_hash ?? "") === p.statementHash,
    };
    const countedFor = this.vicCountedFor(p.paymentIntentId);
    const otherBuyer = pi.metadata?.buyer_id !== undefined && pi.metadata.buyer_id !== b.id;
    const ok = Object.values(checks).every(Boolean) && !countedFor && !otherBuyer;
    if (countedFor || otherBuyer) {
      this.emit(b.id, "refused", `VIC payment ${p.paymentIntentId} cannot count for ${b.name}: ${countedFor ? `already counted toward terms for ${this.state.buyers[countedFor]?.name ?? countedFor}` : `it was made for buyer ${pi.metadata!.buyer_id}`}`, { ...p });
      return false;
    }
    if (ok) {
      b.vicSettledCount += 1;
      (b.vicPaymentIds ??= []).push(p.paymentIntentId);
      this.emit(b.id, "vic", `Visa-verified payment ${usd(Math.round((pi.captured_amount ?? 0) * 100))} checked against Airwallex (statement ${p.statementId}) → counts toward terms`, { ...p, checks });
    } else {
      this.emit(b.id, "refused", `VIC payment ${p.paymentIntentId} did not verify: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`, { ...p, checks });
    }
    return ok;
  }

  /**
   * A card-secured tab: the buyer's passkey-approved Visa authorisation for these orders, checked
   * against Airwallex (authorised, not captured, for exactly their total, tied to the statement).
   */
  async recordCardAuthorisation(buyerId: string, orderIds: string[], p: { paymentIntentId: string; airiMandateId: string; statementId: string; statementHash: string }): Promise<boolean> {
    const b = this.buyer(buyerId);
    if (!this.deps.readPaymentIntent) throw new Error("readPaymentIntent dependency missing");
    const orders = orderIds.map((id) => b.orders.find((o) => o.id === id && o.route === "CARD_AUTH" && !o.card));
    if (orders.some((o) => !o)) throw new Error("every order must be an unauthorised card-secured order");
    const total = orders.reduce((s, o) => s + o!.amount, 0);
    const pi = await this.deps.readPaymentIntent(p.paymentIntentId);
    const checks = {
      authorised: pi.status === "REQUIRES_CAPTURE",
      amount: Math.round(Number(pi.amount ?? 0) * 100) === total,
      statement: pi.merchant_order_id === p.statementId,
      hash: (pi.metadata?.statement_hash ?? "") === p.statementHash,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) {
      this.emit(b.id, "refused", `card authorisation ${p.paymentIntentId} did not verify: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`, { ...p, checks });
      return false;
    }
    for (const o of orders) o!.card = { paymentIntentId: p.paymentIntentId, airiMandateId: p.airiMandateId, statementId: p.statementId, authorised: o!.amount };
    this.emit(b.id, "vic", `Visa authorisation ${usd(total)} holds the tab for ${orders.length} order(s) (statement ${p.statementId}, checked against Airwallex: authorised, not captured)`, { ...p, checks, orderIds });
    return true;
  }

  /** What to capture on a card-secured tab at its due date: what is still owed after credits, decided here, not by the caller. */
  cardCaptureAmount(buyerId: string, paymentIntentId: string): Cents {
    const orders = this.buyer(buyerId).orders.filter((o) => o.card?.paymentIntentId === paymentIntentId && !o.collectedBy);
    if (!orders.length) throw new Error(`no open card-secured orders on ${paymentIntentId}`);
    return orders.reduce((s, o) => s + dueOn(o), 0);
  }

  /**
   * At the due date the supplier captured the undisputed amount. Checked against Airwallex: the
   * capture must equal what is owed after credits, never more. A verified capture is a settled
   * Visa payment, so it counts toward terms (once).
   */
  async verifyCardCapture(buyerId: string, paymentIntentId: string): Promise<boolean> {
    const b = this.buyer(buyerId);
    if (!this.deps.readPaymentIntent) throw new Error("readPaymentIntent dependency missing");
    const orders = b.orders.filter((o) => o.card?.paymentIntentId === paymentIntentId && !o.collectedBy);
    if (!orders.length) throw new Error(`no open card-secured orders on ${paymentIntentId}`);
    const owed = orders.reduce((s, o) => s + dueOn(o), 0);
    const authorised = orders.reduce((s, o) => s + o.card!.authorised, 0);
    const pi = await this.deps.readPaymentIntent(paymentIntentId);
    const captured = Math.round(Number(pi.captured_amount ?? 0) * 100);
    const checks = { succeeded: pi.status === "SUCCEEDED", capturedOwed: captured === owed };
    if (!Object.values(checks).every(Boolean) || this.vicCountedFor(paymentIntentId)) {
      this.emit(b.id, "refused", `card capture on ${paymentIntentId} did not verify: captured ${usd(captured)}, owed ${usd(owed)}, status ${pi.status}`, { paymentIntentId, checks });
      return false;
    }
    for (const o of orders) {
      o.collectedBy = `card:${paymentIntentId}`;
      o.card!.captured = dueOn(o);
    }
    b.vicSettledCount += 1;
    (b.vicPaymentIds ??= []).push(paymentIntentId);
    this.emit(b.id, "vic", `captured ${usd(captured)} of the ${usd(authorised)} authorised: only the undisputed amount; the rest of the hold lapses (checked against Airwallex) → counts toward terms`, { paymentIntentId, captured, authorised, orderIds: orders.map((o) => o.id), checks });
    this.deps.persist?.(this.state);
    return true;
  }

  /** What a proposed policy would do to every buyer right now. Reads live inputs; changes nothing. */
  async dryRunPolicy(proposed: DeskPolicy): Promise<PolicyDiffRow[]> {
    const rows: PolicyDiffRow[] = [];
    const now = this.deps.now();
    for (const b of Object.values(this.state.buyers)) {
      const { input } = await this.inputsFor(b);
      const before = evaluateCredit(input, now, this.creditPolicy(), b.previous);
      const after = evaluateCredit(input, now, proposed.credit, { terms: before.terms, limit: before.limit, ...(input.mandate ? { budget: input.mandate.budget } : {}) });
      const wouldCollect = after.collectNow > 0 ? pickBatch(b, after.collectNow, after.collectMax ?? after.collectNow).net : 0;
      rows.push({ buyerId: b.id, name: b.name, before: { terms: before.terms, limit: before.limit }, after: { terms: after.terms, limit: after.limit }, outstanding: input.outstanding, wouldCollect });
    }
    return rows;
  }

  /**
   * Applies the CFO's policy only if its signature verifies under the supplier's key, then
   * re-evaluates every buyer under it (which may collect, exactly as the dry run showed).
   */
  async applyPolicy(signed: SignedPolicy, diff: PolicyDiffRow[]): Promise<boolean> {
    if (!this.verifies(signed)) {
      const actual = policyHash(signed.policy);
      const why = !this.deps.policyPublicKey ? "no CFO policy key is configured" : `it does not verify under the CFO's key (content or signature changed after signing; signed hash ${signed.hash.slice(0, 12)}…, policy numbers now hash to ${actual.slice(0, 12)}…)`;
      this.emit("desk", "refused", `policy not applied: ${why}`, { signedHash: signed.hash, actualHash: actual });
      return false;
    }
    this.state.policy = signed;
    this.trustedPolicy = signed;
    const changed = signed.accepted.map((c) => policyChangeText(c)).join("; ") || "no change";
    this.emit("desk", "policy", `CFO policy signed and applied: ${changed}${signed.rejected.length ? ` · rejected by code: ${signed.rejected.map((c) => `${c.field} (${c.why})`).join("; ")}` : ""}${signed.notCompiled.length ? ` · not expressible: ${signed.notCompiled.map((n) => n.goal).join("; ")}` : ""}`, { hash: signed.hash, signature: signed.signature, kid: signed.kid, goals: signed.goals, accepted: signed.accepted, rejected: signed.rejected, notCompiled: signed.notCompiled, diff, model: signed.model });
    for (const id of Object.keys(this.state.buyers)) await this.evaluate(id);
    this.deps.persist?.(this.state);
    return true;
  }

  /** The buyer's human bound (or replaced) a debit mandate naming this supplier. */
  recordMandate(buyerId: string, p: { credential: string; mandateKeyFile: string; mandateId: string; tx: string; budget: Cents; replaced?: boolean }) {
    const b = this.buyer(buyerId);
    b.credential = p.credential;
    b.mandateKeyFile = p.mandateKeyFile;
    this.emit(b.id, "mandate", `${p.replaced ? "buyer's human replaced the mandate" : "buyer's human bound a debit mandate"}: budget ${usd(p.budget)}`, { mandateId: p.mandateId, tx: p.tx, budget: p.budget });
  }

  /** Something changed in the books (from T:0 or the stand-in). */
  recordBooks(buyerId: string, summary: string, data: Record<string, unknown> = {}) {
    this.emit(buyerId, "books", summary, data);
  }

  /** Money collected on Metal was settled into Airwallex. */
  recordSettlement(buyerId: string, summary: string, data: Record<string, unknown>) {
    this.emit(buyerId, "settle", summary, data);
  }

  /** The desk's own evidence for each order, used to decide disputes. */
  evidenceFor(buyerId: string): Map<string, OrderEvidence> {
    const b = this.buyer(buyerId);
    return new Map(
      b.orders
        .filter((o) => o.unitPrice !== undefined && o.units !== undefined)
        .map((o) => [o.id, { id: o.id, priceRoute: o.priceRoute ?? "", unitPrice: o.unitPrice!, units: o.units!, staleUnits: o.staleUnits ?? 0, proof: o.collectedBy ? `order ${o.id}, collected in tx ${o.collectedBy}` : `order ${o.id} placed ${o.placedAt}`, credited: o.credited ?? 0, charged: o.amount }]),
    );
  }
}

/** JSON file persistence for the desk (temp file + rename). */
export function fileStore(path: string): { load(): DeskState; save(s: DeskState): void } {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as DeskState;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { buyers: {}, events: [] };
        throw e;
      }
    },
    save(s) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}

/** "net-30 limit $900.00 → $350.00" style text for a policy change. */
export function policyChangeText(c: { field: string; from: number; to: number }): string {
  const money = (v: number) => usd(v);
  const pct = (v: number) => `${+(v * 100).toFixed(2)}%`;
  const fmt: Record<string, [string, (v: number) => string]> = {
    net7Limit: ["net-7 limit", money],
    net30Limit: ["net-30 limit", money],
    net30MinOnTimeInvoices: ["on-time invoices for net-30", String],
    net30MinOnTimeRate: ["on-time rate for net-30", pct],
    graceDays: ["grace days", String],
    earlyPayDiscount: ["early-pay discount", pct],
    earlyPayDays: ["early-pay window (days)", String],
  };
  const [label, f] = fmt[c.field] ?? [c.field, String];
  return `${label} ${f(c.from)} → ${f(c.to)}`;
}
