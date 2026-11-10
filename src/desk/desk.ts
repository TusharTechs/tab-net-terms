import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Books } from "../books/books.js";
import { type CreditDecision, type CreditPolicy, DEFAULT_POLICY, evaluateCredit, type OrderRoute, type PreviousDecision, routeOrder } from "../domain/credit.js";
import type { Cents } from "../domain/money.js";
import type { DisputeDecision, OrderEvidence } from "../disputes/decide.js";
import type { MandateStatus, PullOutcome } from "../metal/agent.js";
import { CATALOG, type PaymentOption, quote } from "../terms/offers.js";

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
  inflight?: { paymentId: string; orderIds: string[]; amount: Cents; creditApplied: Cents; credential: string; mandateKeyFile: string };
  /** Statements issued as their own Metal mandates (the statement IS the mandate). */
  statements?: Statement[];
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
  refusals: { reason: string; tx?: string; at: string }[];
}

export interface DeskEvent {
  seq: number;
  at: string;
  buyerId: string;
  type: "order" | "decision" | "collect" | "collect_refused" | "escalate" | "credit" | "dispute" | "vic" | "mandate" | "books" | "settle" | "agent" | "refused" | "statement" | "proof";
  summary: string;
  data: Record<string, unknown>;
}

export interface DeskState {
  buyers: Record<string, Buyer>;
  events: DeskEvent[];
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
  /** Reads a payment intent from Airwallex, so the VIC gate verifies rather than trusts. */
  readPaymentIntent?(id: string): Promise<{ status: string; captured_amount?: number; merchant_order_id?: string; metadata?: Record<string, string> }>;
  policy?: CreditPolicy;
  persist?(state: DeskState): void;
}

const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;
const openOrders = (b: Buyer) => b.orders.filter((o) => o.route === "ON_TAB" && !o.collectedBy);
/** Orders an accepted statement will collect: the credit-line mandate must not pull them too. */
const onAcceptedStatement = (b: Buyer) => new Set((b.statements ?? []).filter((st) => st.status === "accepted").flatMap((st) => st.orderIds));
const lineCollectable = (b: Buyer) => { const covered = onAcceptedStatement(b); return openOrders(b).filter((o) => !covered.has(o.id)); };
const outstandingOf = (b: Buyer) => Math.max(0, openOrders(b).reduce((s, o) => s + dueOn(o), 0) - (b.creditBalance ?? 0));

/** Payment-id for a collection: hash of exactly which orders (and amounts) it pays for, and any credit netted off. */
export function batchPaymentId(buyerId: string, orders: Pick<Order, "id" | "amount">[], creditApplied: Cents = 0): string {
  const canonical = JSON.stringify(creditApplied ? { buyerId, orders: orders.map((o) => [o.id, o.amount]), creditApplied } : { buyerId, orders: orders.map((o) => [o.id, o.amount]) });
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

export class Desk {
  constructor(
    readonly state: DeskState,
    private readonly deps: DeskDeps,
  ) {}

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
  async evaluate(buyerId: string, afterCollect = false): Promise<CreditDecision> {
    const b = this.buyer(buyerId);
    const mandate = b.credential ? await this.deps.metal.status(b.credential) : undefined;
    const [balance, invoices] = await Promise.all([this.deps.balanceOf(b.account), this.deps.books.invoicesFor(b.id)]);

    const decision = evaluateCredit(
      { buyerId: b.id, supplierPayee: this.deps.supplierPayee, ...(mandate ? { mandate } : {}), onchainBalance: balance, invoices, vicSettledCount: b.vicSettledCount, outstanding: outstandingOf(b) },
      this.deps.now(),
      this.deps.policy ?? DEFAULT_POLICY,
      b.previous,
    );
    const summary = `${decision.terms} · limit ${usd(decision.limit)} · available ${usd(decision.available)}`;
    const lastDecision = [...this.state.events].reverse().find((e) => e.buyerId === b.id && e.type === "decision");
    const unchanged = lastDecision?.summary === summary && decision.collectNow === 0 && decision.escalate === 0;
    if (!unchanged) this.emit(b.id, "decision", summary, {
      decision,
      inputs: { mandate: mandate && { id: mandate.mandateId, budget: mandate.budget, spent: mandate.spent, revoked: mandate.revoked }, balance, booksSource: this.deps.books.sourceFor?.(b.id) ?? this.deps.books.source, invoices: invoices.length },
    });
    b.previous = { terms: decision.terms, limit: decision.limit };

    let collected = false;
    if (decision.collectNow > 0 && b.credential && b.mandateKeyFile) collected = await this.collect(b, decision.collectNow);
    if (decision.escalate > 0) this.emit(b.id, "escalate", `${usd(decision.escalate)} cannot be pulled from the mandate; sent to a person`, { amount: decision.escalate });
    this.deps.persist?.(this.state);
    if (collected && !afterCollect) return this.evaluate(buyerId, true);
    return decision;
  }

  /**
   * Collects `amount` (net of any credit owed to the buyer) against the oldest open orders.
   * The payment-id names exactly those orders and the credit applied.
   */
  private async collect(b: Buyer, amount: Cents): Promise<boolean> {
    if (b.inflight) return this.resolveInflight(b);
    const credit = b.creditBalance ?? 0;
    const batch: Order[] = [];
    let gross = 0;
    for (const o of lineCollectable(b)) {
      if (gross + dueOn(o) > amount + credit) break;
      batch.push(o);
      gross += dueOn(o);
    }
    if (batch.length === 0) return false;
    const applied = Math.min(credit, gross);
    const net = gross - applied;
    const paymentId = batchPaymentId(b.id, batch.map((o) => ({ id: o.id, amount: dueOn(o) })), applied);

    if (net === 0) {
      for (const o of batch) o.collectedBy = `credit:${paymentId.slice(0, 18)}`;
      b.creditBalance = credit - applied;
      this.emit(b.id, "collect", `${batch.length} order(s) settled entirely from credit (${usd(applied)})`, { paymentId, orders: batch.map((o) => o.id), amount: 0, creditApplied: applied });
      return true;
    }
    // Record the pull BEFORE sending it, so a crash or a pending answer can only ever be retried as this same pull.
    b.inflight = { paymentId, orderIds: batch.map((o) => o.id), amount: net, creditApplied: applied, credential: b.credential!, mandateKeyFile: b.mandateKeyFile! };
    this.deps.persist?.(this.state);
    return this.resolveInflight(b);
  }

  /** Sends (or re-sends) the in-flight pull and applies its outcome. Paid/refused clear it; pending/held keep it. */
  private async resolveInflight(b: Buyer): Promise<boolean> {
    const p = b.inflight!;
    const res = await this.deps.metal.pull({ credential: p.credential, mandateKeyFile: p.mandateKeyFile, to: this.deps.supplierPayee, amount: p.amount, paymentId: p.paymentId });
    if (res.outcome === "paid") {
      const batch = b.orders.filter((o) => p.orderIds.includes(o.id));
      for (const o of batch) o.collectedBy = res.tx;
      b.creditBalance = (b.creditBalance ?? 0) - p.creditApplied;
      delete b.inflight;
      const creditNote = p.creditApplied ? ` after ${usd(p.creditApplied)} credit` : "";
      this.emit(b.id, "collect", `collected ${usd(p.amount)} for ${batch.length} order(s)${creditNote}${res.alreadyPaid ? " (already paid earlier)" : ""}`, { tx: res.tx, paymentId: p.paymentId, orders: p.orderIds, amount: p.amount, creditApplied: p.creditApplied });
      return true;
    }
    if (res.outcome === "refused") {
      delete b.inflight;
      this.emit(b.id, "collect_refused", `pull of ${usd(p.amount)} refused: ${res.reason}`, { reason: res.reason, detail: res.detail, paymentId: p.paymentId, amount: p.amount });
    } else {
      this.emit(b.id, "collect_refused", `pull of ${usd(p.amount)} ${res.outcome}; will re-send the same pull before anything else`, { outcome: res.outcome, paymentId: p.paymentId, amount: p.amount });
    }
    this.deps.persist?.(this.state);
    return false;
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
    return quote(productId, units, decision);
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
    const route: Order["route"] = chosen.option === "prepay_card" ? "PREPAY_VIC" : "ON_TAB";
    const order: Order = {
      id, amount: chosen.amount, description: `${p.name} · ${req.units} ${p.unit}`, placedAt: now.toISOString(), route,
      productId: p.id, units: req.units, unitPrice: p.unitPrice, priceRoute: p.priceRoute, option: chosen.option, discount: chosen.discount,
      ...(dueAt ? { dueAt } : {}), ...(req.staleUnits !== undefined ? { staleUnits: req.staleUnits } : {}),
    };
    b.orders.push(order);
    const terms = chosen.option === "prepay_card" ? "prepay by Visa card" : chosen.option === "net_30" ? "net-30 on the tab" : chosen.option === "net_7" ? "net-7 on the tab" : `${chosen.discount * 100}% off, due in ${chosen.dueInDays} days, on the tab`;
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
  applyCredit(buyerId: string, orderId: string, amount: Cents, reason: string): Cents {
    const b = this.buyer(buyerId);
    const o = b.orders.find((x) => x.id === orderId);
    if (!o) throw new Error(`unknown order ${orderId}`);
    const room = o.amount - (o.credited ?? 0);
    const applied = Math.max(0, Math.min(amount, room));
    if (applied === 0) return 0;
    o.credited = (o.credited ?? 0) + applied;
    let where = "reduces what is owed on the tab";
    // A pull already sent for this order (in flight) took the pre-credit amount, so treat it as collected.
    const taken = Boolean(o.collectedBy) || Boolean(b.inflight?.orderIds.includes(orderId));
    if (taken) {
      b.creditBalance = (b.creditBalance ?? 0) + applied;
      where = "carried to the next collection";
    }
    this.emit(b.id, "credit", `credit note ${usd(applied)} on ${orderId}: ${reason} (${where})`, { orderId, amount: applied, reason, collected: taken });
    return applied;
  }

  /**
   * Open tab orders due on the same UTC day as `dueOnDay` that no statement covers yet, priced net
   * of credits. The statement is due at the latest of their due times, so no order is collected early.
   */
  draftStatement(buyerId: string, dueOnDay: string): { id: string; orderIds: string[]; total: Cents; dueAt: string; hash: string } | null {
    const b = this.buyer(buyerId);
    const day = dueOnDay.slice(0, 10);
    const covered = new Set((b.statements ?? []).flatMap((st) => st.orderIds));
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
    st.status = "unpaid";
    this.emit(b.id, "escalate", `statement ${st.id} unpaid after grace: ${usd(st.total)} returns to the credit-line mandate`, { statementId: st.id });
    this.deps.persist?.(this.state);
  }

  /** Records a dispute decision (made in code from the order records) and applies its credits. */
  resolveDispute(buyerId: string, decision: DisputeDecision, meta: { summary: string; model?: string }) {
    let credited = 0;
    for (const f of decision.findings) if (f.verdict === "credit" && f.orderId) credited += this.applyCredit(buyerId, f.orderId, f.amount, f.reason);
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
    const ok = Object.values(checks).every(Boolean);
    if (ok) {
      b.vicSettledCount += 1;
      this.emit(b.id, "vic", `Visa-verified payment ${usd(Math.round((pi.captured_amount ?? 0) * 100))} checked against Airwallex (statement ${p.statementId}) → counts toward terms`, { ...p, checks });
    } else {
      this.emit(b.id, "refused", `VIC payment ${p.paymentIntentId} did not verify: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`, { ...p, checks });
    }
    return ok;
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
        .map((o) => [o.id, { id: o.id, priceRoute: o.priceRoute ?? "", unitPrice: o.unitPrice!, units: o.units!, staleUnits: o.staleUnits ?? 0, proof: o.collectedBy ? `order ${o.id}, collected in tx ${o.collectedBy}` : `order ${o.id} placed ${o.placedAt}`, credited: o.credited ?? 0 }]),
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
