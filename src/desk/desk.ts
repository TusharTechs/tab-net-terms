import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Books } from "../books/books.js";
import { type CreditDecision, type CreditPolicy, DEFAULT_POLICY, evaluateCredit, type OrderRoute, type PreviousDecision, routeOrder } from "../domain/credit.js";
import type { Cents } from "../domain/money.js";
import type { DisputeDecision, OrderEvidence } from "../disputes/decide.js";
import type { MandateStatus, PullOutcome } from "../metal/agent.js";

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
}

export interface DeskEvent {
  seq: number;
  at: string;
  buyerId: string;
  type: "order" | "decision" | "collect" | "collect_refused" | "escalate" | "credit" | "dispute";
  summary: string;
  data: Record<string, unknown>;
}

export interface DeskState {
  buyers: Record<string, Buyer>;
  events: DeskEvent[];
}

export interface DeskDeps {
  supplierPayee: string;
  metal: {
    status(credential: string): Promise<MandateStatus>;
    pull(p: { credential: string; mandateKeyFile: string; to: string; amount: Cents; paymentId: string }): Promise<PullOutcome>;
  };
  balanceOf(address: string): Promise<Cents>;
  books: Books;
  now(): Date;
  policy?: CreditPolicy;
  persist?(state: DeskState): void;
}

const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;
const openOrders = (b: Buyer) => b.orders.filter((o) => o.route === "ON_TAB" && !o.collectedBy);
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

  /** Re-reads mandate, balance and books, decides, and collects if the decision says so. */
  async evaluate(buyerId: string): Promise<CreditDecision> {
    const b = this.buyer(buyerId);
    const mandate = b.credential ? await this.deps.metal.status(b.credential) : undefined;
    const [balance, invoices] = await Promise.all([this.deps.balanceOf(b.account), this.deps.books.invoicesFor(b.id)]);

    const decision = evaluateCredit(
      { buyerId: b.id, supplierPayee: this.deps.supplierPayee, ...(mandate ? { mandate } : {}), onchainBalance: balance, invoices, vicSettledCount: b.vicSettledCount, outstanding: outstandingOf(b) },
      this.deps.now(),
      this.deps.policy ?? DEFAULT_POLICY,
      b.previous,
    );
    this.emit(b.id, "decision", `${decision.terms} · limit ${usd(decision.limit)} · available ${usd(decision.available)}`, {
      decision,
      inputs: { mandate: mandate && { id: mandate.mandateId, budget: mandate.budget, spent: mandate.spent, revoked: mandate.revoked }, balance, booksSource: this.deps.books.source, invoices: invoices.length },
    });
    b.previous = { terms: decision.terms, limit: decision.limit };

    if (decision.collectNow > 0 && b.credential && b.mandateKeyFile) await this.collect(b, decision.collectNow);
    if (decision.escalate > 0) this.emit(b.id, "escalate", `${usd(decision.escalate)} cannot be pulled from the mandate; sent to a person`, { amount: decision.escalate });
    this.deps.persist?.(this.state);
    return decision;
  }

  /**
   * Collects `amount` (net of any credit owed to the buyer) against the oldest open orders.
   * The payment-id names exactly those orders and the credit applied.
   */
  private async collect(b: Buyer, amount: Cents) {
    const credit = b.creditBalance ?? 0;
    const batch: Order[] = [];
    let gross = 0;
    for (const o of openOrders(b)) {
      if (gross + dueOn(o) > amount + credit) break;
      batch.push(o);
      gross += dueOn(o);
    }
    if (batch.length === 0) return;
    const applied = Math.min(credit, gross);
    const net = gross - applied;
    const paymentId = batchPaymentId(b.id, batch.map((o) => ({ id: o.id, amount: dueOn(o) })), applied);

    if (net === 0) {
      for (const o of batch) o.collectedBy = `credit:${paymentId.slice(0, 18)}`;
      b.creditBalance = credit - applied;
      this.emit(b.id, "collect", `${batch.length} order(s) settled entirely from credit (${usd(applied)})`, { paymentId, orders: batch.map((o) => o.id), amount: 0, creditApplied: applied });
      return;
    }
    const res = await this.deps.metal.pull({ credential: b.credential!, mandateKeyFile: b.mandateKeyFile!, to: this.deps.supplierPayee, amount: net, paymentId });
    if (res.outcome === "paid") {
      for (const o of batch) o.collectedBy = res.tx;
      b.creditBalance = credit - applied;
      const creditNote = applied ? ` after ${usd(applied)} credit` : "";
      this.emit(b.id, "collect", `collected ${usd(net)} for ${batch.length} order(s)${creditNote}${res.alreadyPaid ? " (already paid earlier)" : ""}`, { tx: res.tx, paymentId, orders: batch.map((o) => o.id), amount: net, creditApplied: applied });
    } else if (res.outcome === "refused") {
      this.emit(b.id, "collect_refused", `pull of ${usd(net)} refused: ${res.reason}`, { reason: res.reason, detail: res.detail, paymentId, amount: net });
    } else {
      this.emit(b.id, "collect_refused", `pull of ${usd(net)} ${res.outcome}`, { outcome: res.outcome, paymentId, amount: net });
    }
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
    if (o.collectedBy) {
      b.creditBalance = (b.creditBalance ?? 0) + applied;
      where = "carried to the next collection";
    }
    this.emit(b.id, "credit", `credit note ${usd(applied)} on ${orderId}: ${reason} (${where})`, { orderId, amount: applied, reason, collected: Boolean(o.collectedBy) });
    return applied;
  }

  /** Records a dispute decision (made in code from the order records) and applies its credits. */
  resolveDispute(buyerId: string, decision: DisputeDecision, meta: { summary: string; model?: string }) {
    let credited = 0;
    for (const f of decision.findings) if (f.verdict === "credit" && f.orderId) credited += this.applyCredit(buyerId, f.orderId, f.amount, f.reason);
    const upheld = decision.findings.filter((f) => f.verdict === "upheld_for_supplier").length;
    const escalated = decision.findings.filter((f) => f.verdict === "escalate").length;
    this.emit(buyerId, "dispute", `dispute resolved: ${usd(credited)} credited, ${upheld} claim(s) upheld with proof, ${escalated} to a person`, { ...meta, findings: decision.findings });
    if (escalated) this.emit(buyerId, "escalate", `${escalated} dispute claim(s) need a person`, { findings: decision.findings.filter((f) => f.verdict === "escalate") });
    this.deps.persist?.(this.state);
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
