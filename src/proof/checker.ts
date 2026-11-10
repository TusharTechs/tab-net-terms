import { type DeskState, dueOn } from "../desk/desk.js";
import type { Cents } from "../domain/money.js";

/**
 * "Every dollar proven": invariants over the desk's books, plus optional live checks against the
 * chain, Airwallex and T:0. A break means money was taken twice, lost, or cannot be traced.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  ids?: string[];
}

const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;

/** Pure invariants over the desk state (no network). */
export function checkBooks(state: DeskState): Check[] {
  const out: Check[] = [];
  for (const b of Object.values(state.buyers)) {
    // A buyer that never ordered has nothing to prove; listing it would only pad the count.
    if (b.orders.length === 0) continue;
    const tab = b.orders.filter((o) => o.route === "ON_TAB");
    // Count each collection once, keyed by its chain tx (or payment-id for credit-only settlements).
    // A pull that answered "pending" and later resolved appears once, as "already paid earlier".
    const byKey = new Map<string, (typeof state.events)[number]>();
    for (const e of state.events) {
      if (e.buyerId !== b.id || e.type !== "collect") continue;
      const key = String(e.data.tx ?? `pid:${e.data.paymentId}`);
      if (!byKey.has(key)) byKey.set(key, e);
    }
    const collects = [...byKey.values()];
    const collected = collects.reduce((s, e) => s + Number(e.data.amount ?? 0), 0);
    const owedNet = tab.reduce((s, o) => s + dueOn(o), 0);
    const open = tab.filter((o) => !o.collectedBy).reduce((s, o) => s + dueOn(o), 0);
    const credit = b.creditBalance ?? 0;
    out.push({
      name: `${b.id}: charged − credits = collected + open − credit owed`,
      ok: owedNet === collected + open - credit,
      detail: `${usd(owedNet)} = ${usd(collected)} + ${usd(open)} − ${usd(credit)}`,
    });

    // No order appears in two paid collections.
    const seen = new Map<string, string>();
    const doubles: string[] = [];
    for (const e of collects) for (const id of (e.data.orders as string[] | undefined) ?? []) {
      if (seen.has(id)) doubles.push(id);
      seen.set(id, String(e.data.tx ?? e.data.paymentId));
    }
    out.push({ name: `${b.id}: no order collected twice`, ok: doubles.length === 0, detail: doubles.length ? `collected twice: ${doubles.join(", ")}` : `${seen.size} order(s), each collected once`, ...(doubles.length ? { ids: doubles } : {}) });

    // One payment-id never maps to two different transactions.
    const byPid = new Map<string, Set<string>>();
    for (const e of collects) if (e.data.paymentId && e.data.tx) (byPid.get(String(e.data.paymentId)) ?? byPid.set(String(e.data.paymentId), new Set()).get(String(e.data.paymentId))!).add(String(e.data.tx));
    const split = [...byPid.entries()].filter(([, txs]) => txs.size > 1).map(([pid]) => pid);
    out.push({ name: `${b.id}: one transaction per payment-id`, ok: split.length === 0, detail: split.length ? `payment-ids with several txs: ${split.join(", ")}` : `${byPid.size} payment-id(s)` });

    // Every collected order points at a collection the log can show.
    const logged = new Set(collects.flatMap((e) => ((e.data.orders as string[] | undefined) ?? [])));
    const unlogged = tab.filter((o) => o.collectedBy && !o.collectedBy.startsWith("credit:") && !logged.has(o.id)).map((o) => o.id);
    out.push({ name: `${b.id}: every collected order is traceable`, ok: unlogged.length === 0, detail: unlogged.length ? `no collection logged for ${unlogged.join(", ")}` : "all traceable" });

    // Card-secured tabs: what was captured is exactly what was owed after credits, never above the authorisation.
    const card = b.orders.filter((o) => o.route === "CARD_AUTH");
    if (card.length) {
      const bad = card.filter((o) => o.collectedBy && (o.card?.captured !== dueOn(o) || (o.card?.captured ?? 0) > (o.card?.authorised ?? 0))).map((o) => o.id);
      const captured = card.reduce((s, o) => s + (o.card?.captured ?? 0), 0);
      const authorised = card.reduce((s, o) => s + (o.card?.authorised ?? 0), 0);
      out.push({ name: `${b.id}: card captures = owed after credits, within the authorisation`, ok: bad.length === 0, detail: bad.length ? `mismatch on ${bad.join(", ")}` : `${usd(captured)} captured of ${usd(authorised)} authorised on ${card.length} order(s)`, ...(bad.length ? { ids: bad } : {}) });
    }

    // Credits for stale units are priced at what the buyer was charged per unit, never at list, never above the order.
    const mispriced: string[] = [];
    for (const e of state.events) {
      if (e.buyerId !== b.id || e.type !== "credit") continue;
      const o = b.orders.find((x) => x.id === e.data.orderId);
      const amt = Number(e.data.amount ?? 0);
      if (!o || amt > o.amount) { mispriced.push(String(e.data.orderId)); continue; }
      const n = e.data.staleUnits as number | undefined;
      if (n !== undefined && o.units && amt !== Math.round((n * o.amount) / o.units)) mispriced.push(`${o.id} (${n} unit(s): ${usd(amt)} credited, ${usd(Math.round((n * o.amount) / o.units))} charged)`);
    }
    const credits = state.events.filter((e) => e.buyerId === b.id && e.type === "credit");
    const perUnit = credits.filter((e) => e.data.staleUnits !== undefined).length;
    const detail = `${perUnit} re-priced at the charged unit price${credits.length > perUnit ? `, ${credits.length - perUnit} checked only against the order total (no unit count recorded)` : ""}`;
    if (credits.length) out.push({ name: `${b.id}: credits priced at what was charged`, ok: mispriced.length === 0, detail: mispriced.length ? `mispriced: ${mispriced.join("; ")}` : detail, ...(mispriced.length ? { ids: mispriced } : {}) });

    // Statement refusals are evidence: each recorded one carries its chain tx.
    for (const st of b.statements ?? []) {
      const missing = st.refusals.filter((r) => !r.tx).length;
      if (st.refusals.length) out.push({ name: `${b.id}: statement ${st.id} refusals recorded on chain`, ok: missing === 0, detail: `${st.refusals.length} refusal(s), ${missing} without a chain record`, ids: st.refusals.flatMap((r) => (r.tx ? [r.tx] : [])) });
    }
  }
  return out;
}

export interface Receipt {
  status: string;
  from: string;
  logs: { address: string; topics: string[]; data: string }[];
}

export interface LiveDeps {
  receiptStatus(tx: string): Promise<string | null>;
  /** Full receipts: lets the check confirm the amount and both parties of every collection, and who recorded each refusal. */
  receipt?(tx: string): Promise<Receipt | null>;
  /** The supplier's wallet (payee of every collection, sender of every recorded refusal) and the USDZ token. */
  supplier?: string;
  token?: string;
  conversionStatus?(id: string): Promise<string>;
  journalEntry?(id: string): Promise<{ total_debit_atoms: number; total_credit_atoms: number } | null>;
  /** Airwallex payment intent: amount captured, in dollars. */
  paymentIntent?(id: string): Promise<{ status: string; captured_amount?: number }>;
}

/** Live checks: every collection tx succeeded on chain; settlements and journal entries exist and balance. */
export async function checkLive(state: DeskState, deps: LiveDeps): Promise<Check[]> {
  const out: Check[] = [];
  const txs = [...new Set(state.events.filter((e) => e.type === "collect" && e.data.tx).map((e) => String(e.data.tx)))];
  const bad: string[] = [];
  for (const tx of txs) if ((await deps.receiptStatus(tx)) !== "0x1") bad.push(tx);
  out.push({ name: "every collection succeeded on chain", ok: bad.length === 0, detail: `${txs.length - bad.length}/${txs.length} receipts status 0x1`, ids: txs });

  if (deps.receipt && deps.supplier) {
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const norm = (a: string) => a.toLowerCase().replace(/^0x/, "").slice(-40).padStart(40, "0");
    const addr = (topic: string) => norm(topic);
    const supplier = norm(deps.supplier);
    // One check per collection tx: a Transfer of exactly the collected amount, from the buyer to the supplier.
    const seen = new Set<string>();
    const wrong: string[] = [];
    for (const e of state.events.filter((x) => x.type === "collect" && x.data.tx)) {
      const tx = String(e.data.tx);
      if (seen.has(tx)) continue;
      seen.add(tx);
      const buyer = norm(state.buyers[e.buyerId]?.account ?? "");
      const want = BigInt(Number(e.data.amount ?? 0)) * 10n ** 16n;
      const r = await deps.receipt(tx);
      const hit = r?.logs.some((l) => l.topics[0] === TRANSFER && (!deps.token || l.address.toLowerCase() === deps.token.toLowerCase()) && addr(l.topics[1] ?? "") === buyer && addr(l.topics[2] ?? "") === supplier && BigInt(l.data.slice(0, 66)) === want);
      if (!hit) wrong.push(tx);
    }
    out.push({ name: "every collection moved exactly its amount from the buyer to Northwind", ok: wrong.length === 0, detail: wrong.length ? `no matching transfer in ${wrong.join(", ")}` : `${seen.size}/${seen.size} transfer logs match amount, buyer and payee`, ids: [...seen] });

    // Recorded refusals: real transactions, sent by the supplier.
    const refusals = [...new Set(state.events.filter((x) => x.type === "refused" && x.data.tx).map((x) => String(x.data.tx)))];
    if (refusals.length) {
      const badR: string[] = [];
      for (const tx of refusals) {
        const r = await deps.receipt(tx);
        if (!r || r.status !== "0x1" || norm(r.from) !== supplier) badR.push(tx);
      }
      out.push({ name: "every refusal is recorded on chain by Northwind", ok: badR.length === 0, detail: `${refusals.length - badR.length}/${refusals.length} refusal txs succeeded, sent by the supplier`, ids: refusals });
    }
  }

  for (const e of state.events.filter((x) => x.type === "settle" && x.data.conversionId)) {
    const tx = String(e.data.metalTx ?? "");
    const known = txs.includes(tx);
    const conv = deps.conversionStatus ? await deps.conversionStatus(String(e.data.conversionId)) : "unchecked";
    out.push({ name: `settlement of ${tx.slice(0, 10)}…`, ok: known && (conv === "SETTLED" || conv === "unchecked"), detail: `${known ? "matches a collection" : "NO matching collection"}; conversion ${conv}`, ids: [String(e.data.depositId), String(e.data.conversionId)] });
  }
  // Every card capture the desk counted matches what Airwallex says was captured.
  if (deps.paymentIntent) {
    const byPi = new Map<string, number>();
    for (const b of Object.values(state.buyers)) for (const o of b.orders) if (o.card?.captured !== undefined) byPi.set(o.card.paymentIntentId, (byPi.get(o.card.paymentIntentId) ?? 0) + o.card.captured);
    for (const [pi, desk] of byPi) {
      const r = await deps.paymentIntent(pi);
      const awx = Math.round(Number(r.captured_amount ?? 0) * 100);
      out.push({ name: `card capture ${pi}`, ok: r.status === "SUCCEEDED" && awx === desk, detail: `Airwallex captured ${usd(awx)} (${r.status}); desk counted ${usd(desk)}`, ids: [pi] });
    }
  }

  for (const e of state.events.filter((x) => x.type === "books" && x.data.journalEntryId)) {
    const je = deps.journalEntry ? await deps.journalEntry(String(e.data.journalEntryId)) : null;
    const tx = String(e.data.metalTx ?? "");
    // What that chain tx actually collected, in cents (USD journal entries carry 100 atoms per dollar).
    const collected = [...new Map(state.events.filter((x) => x.type === "collect" && x.data.tx === tx).map((x) => [x.data.tx, Number(x.data.amount ?? 0)])).values()].reduce((s, a) => s + a, 0);
    const balanced = je !== null && je.total_debit_atoms === je.total_credit_atoms;
    const amountMatches = je !== null && je.total_debit_atoms === collected;
    out.push({
      name: `T:0 journal ${e.data.journalEntryId}`,
      ok: txs.includes(tx) && (!deps.journalEntry || (balanced && amountMatches)),
      detail: `${txs.includes(tx) ? "tied to a collection" : "NOT tied to a collection"}${je ? `; balanced ${je.total_debit_atoms}/${je.total_credit_atoms}; ${amountMatches ? "equals" : "DOES NOT equal"} the ${usd(collected)} collected` : ""}`,
      ids: [String(e.data.journalEntryId)],
    });
  }
  return out;
}
