import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Books } from "../books/books.js";
import { type CreditDecision, type CreditPolicy, DEFAULT_POLICY, evaluateCredit, type OrderRoute, type PreviousDecision, routeOrder } from "../domain/credit.js";
import type { Cents } from "../domain/money.js";
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
  /** Set once a pull collected it. */
  collectedBy?: string;
}

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
}

export interface DeskEvent {
  seq: number;
  at: string;
  buyerId: string;
  type: "order" | "decision" | "collect" | "collect_refused" | "escalate";
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
const outstandingOf = (b: Buyer) => b.orders.filter((o) => o.route === "ON_TAB" && !o.collectedBy).reduce((s, o) => s + o.amount, 0);

/** Payment-id for a collection: hash of exactly which orders (and amounts) it pays for. */
export function batchPaymentId(buyerId: string, orders: Pick<Order, "id" | "amount">[]): string {
  const canonical = JSON.stringify({ buyerId, orders: orders.map((o) => [o.id, o.amount]) });
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

  /** Pulls `amount` against the oldest uncollected orders. The payment-id names exactly those orders. */
  private async collect(b: Buyer, amount: Cents) {
    const batch: Order[] = [];
    let sum = 0;
    for (const o of b.orders.filter((x) => x.route === "ON_TAB" && !x.collectedBy)) {
      if (sum + o.amount > amount) break;
      batch.push(o);
      sum += o.amount;
    }
    if (sum === 0) return;
    const paymentId = batchPaymentId(b.id, batch);
    const res = await this.deps.metal.pull({ credential: b.credential!, mandateKeyFile: b.mandateKeyFile!, to: this.deps.supplierPayee, amount: sum, paymentId });
    if (res.outcome === "paid") {
      for (const o of batch) o.collectedBy = res.tx;
      this.emit(b.id, "collect", `collected ${usd(sum)} for ${batch.length} order(s)${res.alreadyPaid ? " (already paid earlier)" : ""}`, { tx: res.tx, paymentId, orders: batch.map((o) => o.id), amount: sum });
    } else if (res.outcome === "refused") {
      this.emit(b.id, "collect_refused", `pull of ${usd(sum)} refused: ${res.reason}`, { reason: res.reason, detail: res.detail, paymentId, amount: sum });
    } else {
      this.emit(b.id, "collect_refused", `pull of ${usd(sum)} ${res.outcome}`, { outcome: res.outcome, paymentId, amount: sum });
    }
  }

  /** An agent order arrives. It goes on the tab only if it fits; otherwise prepay (VIC ≤ $200, else invoice). */
  async placeOrder(buyerId: string, order: { id: string; amount: Cents; description: string }): Promise<OrderRoute> {
    const b = this.buyer(buyerId);
    const decision = await this.evaluate(buyerId);
    const route = routeOrder(decision, order.amount);
    b.orders.push({ ...order, placedAt: this.deps.now().toISOString(), route: route.kind });
    const where = route.kind === "ON_TAB" ? "on the tab" : route.kind === "PREPAY_VIC" ? "prepay by VIC card" : "prepay by invoice (over the $200 VIC cap)";
    this.emit(b.id, "order", `${order.id} ${usd(order.amount)} → ${where}`, { order, route });
    return route;
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
