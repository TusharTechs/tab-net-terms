import { type AirwallexClient, AirwallexError } from "../airwallex/client.js";
import { T0_GL, type T0Mcp } from "../books/books.js";
import { billPaymentRecord, submitRecords } from "../books/t0records.js";
import type { DeskState } from "../desk/desk.js";
import type { Cents } from "../domain/money.js";

/**
 * "Pay the vendor, once, from proven money." Northwind keeps its treasury in SGD, built only from
 * collections the desk proved on chain. It reads its open vendor bills from T:0, and code decides:
 * oldest first, pay a bill only if its SGD cost fits inside proven money minus a floor kept back,
 * send anything over the per-bill limit (or not covered) to a person, and never pay a bill twice.
 * The payment is one Airwallex transfer funded in SGD and paid in the bill's currency.
 */

export interface VendorBill {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  currency: string;
  /** In cents of the bill's currency. */
  amount: Cents;
  dueDate: string;
}

export interface PayoutRules {
  /** SGD kept back from proven money, never paid out (refunds and fees). */
  floorSgd: Cents;
  /** Above this SGD cost a person approves the bill; the desk does not pay it. */
  maxPerBillSgd: Cents;
}
export const DEFAULT_PAYOUT_RULES: PayoutRules = { floorSgd: 5_000, maxPerBillSgd: 100_000 };

export type PayoutDecision =
  | { bill: VendorBill; verdict: "pay"; sgdCost: Cents; reason: string }
  | { bill: VendorBill; verdict: "person"; sgdCost: Cents | null; reason: string }
  | { bill: VendorBill; verdict: "already_paid"; reason: string };

const sgd = (c: Cents) => `SGD ${(c / 100).toFixed(2)}`;

/**
 * Pure. Oldest bill first; each payable bill spends from what proven money has left after the
 * floor. `costs` is each bill's SGD cost from a live quote.
 */
export function decidePayouts(
  bills: VendorBill[],
  costs: Map<string, Cents>,
  ctx: { provenSgd: Cents; spentSgd: Cents; paidBillIds: Set<string>; paidReasons?: Map<string, string> },
  rules: PayoutRules = DEFAULT_PAYOUT_RULES,
): PayoutDecision[] {
  let available = ctx.provenSgd - ctx.spentSgd - rules.floorSgd;
  return [...bills]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.amount - b.amount)
    .map((bill): PayoutDecision => {
      if (ctx.paidBillIds.has(bill.id)) return { bill, verdict: "already_paid", reason: ctx.paidReasons?.get(bill.id) ?? "this bill was already paid: the duplicate lock refuses it" };
      const cost = costs.get(bill.id);
      if (cost === undefined) return { bill, verdict: "person", sgdCost: null, reason: "no SGD quote for this bill: a person decides" };
      if (cost > rules.maxPerBillSgd) return { bill, verdict: "person", sgdCost: cost, reason: `${sgd(cost)} is over the ${sgd(rules.maxPerBillSgd)} per-bill limit: a person approves it` };
      if (cost > available) return { bill, verdict: "person", sgdCost: cost, reason: `${sgd(cost)} is more than proven money covers (${sgd(Math.max(0, available))} left after the ${sgd(rules.floorSgd)} floor): a person decides` };
      available -= cost;
      return { bill, verdict: "pay", sgdCost: cost, reason: `${sgd(cost)} fits inside proven money (${sgd(available)} left after it and the floor)` };
    });
}

/** SGD this run proved: what its settled collections converted into (Metal → Airwallex → SGD). */
export function provenSgdOf(state: DeskState): Cents {
  let total = 0;
  for (const e of state.events) {
    if (e.type !== "settle" || !e.data.conversionId) continue;
    const fromData = e.data.sgdCents as number | undefined;
    const m = /→ ([\d.]+) SGD/.exec(e.summary);
    total += fromData ?? (m ? Math.round(Number(m[1]) * 100) : 0);
  }
  return total;
}

/** SGD already spent on vendor payouts, and the bills already paid, from the desk log. */
export function payoutsOf(state: DeskState): { spentSgd: Cents; paidBillIds: Set<string> } {
  let spentSgd = 0;
  const paidBillIds = new Set<string>();
  for (const e of state.events) {
    if (e.type !== "payout") continue;
    spentSgd += Number(e.data.sgdCents ?? 0);
    paidBillIds.add(String(e.data.billId));
  }
  return { spentSgd, paidBillIds };
}

/** Open vendor bills from T:0, with vendor names. */
export async function openVendorBills(t0: T0Mcp): Promise<VendorBill[]> {
  const rows: { id: { externalId: string }; data: { status: string; currencyCode: string; total: number; dueDate: string; customFields?: { bill_number?: string } }; links: { dataType: string; externalId: string }[] }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 6; page++) {
    const r = await t0.call<{ data?: typeof rows; next_cursor?: string }>("list_vendor_bills", { limit: 50, ...(cursor ? { cursor } : {}) });
    rows.push(...(r.data ?? []));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  const open = rows.filter((b) => b.data.status === "open");
  const names = new Map<string, string>();
  for (const b of open) {
    const vid = b.links.find((l) => l.dataType === "Vendor")?.externalId ?? "";
    if (vid && !names.has(vid)) names.set(vid, (await t0.call<{ data?: { name?: string } }>("get_one_vendor", { external_id: vid })).data?.name ?? vid);
  }
  return open.map((b) => {
    const vid = b.links.find((l) => l.dataType === "Vendor")?.externalId ?? "";
    return { id: b.id.externalId, number: b.data.customFields?.bill_number ?? b.id.externalId, vendorId: vid, vendorName: names.get(vid) ?? vid, currency: b.data.currencyCode, amount: Math.round(b.data.total * 100), dueDate: b.data.dueDate };
  });
}

/**
 * Records the payment against the bill itself in T:0 (a BillPayment linked to the bill and vendor),
 * so T:0's own books show the bill paid after its nightly run. Needs the Custom API connection key.
 * Fixed id per bill: a repeat replaces it rather than adding a second payment.
 */
export async function recordBillPayment(t0Import: T0Mcp, p: { bill: VendorBill; transferId: string; shortRef: string; date: Date }): Promise<string> {
  const rec = billPaymentRecord({ billExternalId: p.bill.id, vendorExternalId: p.bill.vendorId, amountCents: p.bill.amount, date: p.date, transferId: p.transferId, shortRef: p.shortRef });
  await submitRecords(t0Import, [rec]);
  return rec.id.externalId;
}

/** What a bill costs in SGD right now (rounded up to the cent). */
export async function quoteSgdCost(awx: AirwallexClient, currency: string, amount: Cents): Promise<{ sgdCents: Cents; rate: number; quoteId: string }> {
  const q = await awx.post<{ sell_amount: number; client_rate: number; quote_id: string }>("/fx/quotes/create", { buy_currency: currency, sell_currency: "SGD", buy_amount: amount / 100, validity: "MIN_1" });
  return { sgdCents: Math.ceil(q.sell_amount * 100), rate: q.client_rate, quoteId: q.quote_id };
}

export interface PaidTransfer {
  transferId: string;
  shortRef: string;
  status: string;
  sgdCents: Cents;
  paidCents: Cents;
  requestId: string;
  alreadyDone: boolean;
}

interface TransferRow { id: string; short_reference_id?: string; status: string; source_amount: number; transfer_amount: number; request_id: string; reference?: string; beneficiary_id?: string; transfer_currency?: string }

/** The Airwallex request id for paying a bill: it names the bill only, so every run and every retry asks for the same one. */
export const payoutRequestId = (bill: VendorBill) => `tab-bill-${bill.id}`.slice(0, 64);

const DEAD = new Set(["FAILED", "CANCELLED", "RETURNED", "REJECTED"]);

/**
 * Any live transfer already paying this bill: same reference (the bill number), payee, currency and
 * amount. Catches a payment made under a different request id (an earlier scheme, or by hand).
 */
export async function transferForBill(awx: AirwallexClient, bill: VendorBill, beneficiaryId: string, maxPages = 10): Promise<TransferRow | undefined> {
  const ref = bill.number.slice(0, 35);
  for (let page = 0; page < maxPages; page++) {
    const r = await awx.get<{ items?: TransferRow[] }>(`/transfers?page_num=${page}&page_size=100`);
    const items = r.items ?? [];
    const hit = items.find((t) => t.reference === ref && t.beneficiary_id === beneficiaryId && t.transfer_currency === bill.currency && Math.round(t.transfer_amount * 100) === bill.amount && !DEAD.has(t.status));
    if (hit) return hit;
    if (items.length < 100) return undefined;
  }
  return undefined;
}

/**
 * Which of these bills Airwallex already shows paid, before anything is decided: a live transfer under
 * the bill's request id, or one with its number, amount and payee. T:0 can still show such a bill open
 * (its payment not recorded there); the desk must not pay it, or spend proven money on it, again.
 */
export async function paidOnAirwallex(awx: AirwallexClient, bills: VendorBill[], beneficiaries: Record<string, string>, maxPages = 10): Promise<Map<string, TransferRow>> {
  const all: TransferRow[] = [];
  for (let page = 0; page < maxPages; page++) {
    const items = (await awx.get<{ items?: TransferRow[] }>(`/transfers?page_num=${page}&page_size=100`)).items ?? [];
    all.push(...items);
    if (items.length < 100) break;
  }
  const out = new Map<string, TransferRow>();
  for (const b of bills) {
    const ben = beneficiaries[b.vendorId];
    if (!ben) continue;
    const live = all.filter((t) => !DEAD.has(t.status));
    const hit = live.find((t) => t.request_id === payoutRequestId(b)) ?? live.find((t) => t.reference === b.number.slice(0, 35) && t.beneficiary_id === ben && t.transfer_currency === b.currency && Math.round(t.transfer_amount * 100) === b.amount);
    if (hit) out.set(b.id, hit);
  }
  return out;
}

/** The reason shown for a bill Airwallex already shows paid. */
export const paidOnAirwallexReason = (t: TransferRow) => `already paid by Airwallex transfer ${t.short_reference_id || t.id} (${t.status}); T:0 still shows the bill open`;

/**
 * Pays one bill: an Airwallex transfer funded in SGD, paid in the bill's currency, to the vendor's
 * beneficiary. Two locks come first, both answered by Airwallex: the request id names the bill, so a
 * retry or a later run finds the first transfer; and a live transfer of the same bill number, amount
 * and payee under any request id also counts as paid. In the sandbox the transfer is moved to SENT
 * and then PAID with the simulation call.
 */
export async function payVendorBill(
  awx: AirwallexClient,
  p: { bill: VendorBill; beneficiaryId: string; requestId: string; simulate: boolean },
): Promise<PaidTransfer> {
  const toPaid = (t: TransferRow, alreadyDone: boolean): PaidTransfer => ({ transferId: t.id, shortRef: t.short_reference_id ?? "", status: t.status, sgdCents: Math.round(t.source_amount * 100), paidCents: Math.round(t.transfer_amount * 100), requestId: t.request_id, alreadyDone });
  const existing = await awx.get<{ items?: TransferRow[] }>(`/transfers?request_id=${encodeURIComponent(p.requestId)}`);
  const prior = (existing.items ?? []).find((t) => t.request_id === p.requestId);
  if (prior) return toPaid(prior, true);
  const sameBill = await transferForBill(awx, p.bill, p.beneficiaryId);
  if (sameBill) return toPaid(sameBill, true);
  let t: TransferRow;
  try {
    t = await awx.post<TransferRow>("/transfers/create", {
      request_id: p.requestId,
      beneficiary_id: p.beneficiaryId,
      source_currency: "SGD",
      transfer_currency: p.bill.currency,
      transfer_amount: p.bill.amount / 100,
      transfer_method: "LOCAL",
      reason: "payment_to_supplier",
      reference: p.bill.number.slice(0, 35),
    });
  } catch (e) {
    // A lost response on the first try: the transfer exists under this request id.
    if (e instanceof AirwallexError && e.code === "duplicate_request_id") {
      const again = await awx.get<{ items?: TransferRow[] }>(`/transfers?request_id=${encodeURIComponent(p.requestId)}`);
      const found = (again.items ?? []).find((x) => x.request_id === p.requestId);
      if (found) return toPaid(found, true);
    }
    throw e;
  }
  if (p.simulate) {
    for (const next of ["SENT", "PAID"]) await awx.post(`/simulation/transfers/${t.id}/transition`, { next_status: next });
  }
  return toPaid(await awx.get<TransferRow>(`/transfers/${t.id}`), false);
}

/** Books the payment in T:0: debit A/P - Vendors (the vendor), credit the Airwallex cash account. */
export async function bookPayout(
  t0: T0Mcp,
  p: { bill: VendorBill; transferId: string; shortRef: string; date: Date },
): Promise<{ journalEntryId: string; jeNumber?: string; alreadyBooked: boolean }> {
  const body = {
    entry_date: p.date.toISOString().slice(0, 10),
    currency: p.bill.currency,
    memo: `TAB vendor payout: bill ${p.bill.number} paid by Airwallex transfer ${p.transferId}${p.shortRef ? ` (${p.shortRef})` : ""}, funded in SGD from proven collections`,
    manual_entry_reason: "Vendor bill paid by Airwallex transfer from settled collections",
    idempotency_key: `tab-payout-${p.transferId}`.slice(0, 128),
    lines: [
      { gl_account_id: T0_GL.payable, line_type: "debit", amount_atoms: p.bill.amount, memo: `bill ${p.bill.number}`, counterparty_type: "vendor", counterparty_external_id: p.bill.vendorId },
      { gl_account_id: T0_GL.cash, line_type: "credit", amount_atoms: p.bill.amount, memo: `Airwallex transfer ${p.transferId}` },
    ],
  };
  try {
    const je = await t0.call<{ id: string; je_number?: string }>("post_a_manual_journal_entry", { body });
    return { journalEntryId: je.id, ...(je.je_number ? { jeNumber: je.je_number } : {}), alreadyBooked: false };
  } catch (e) {
    const m = /CAPI34.*created (je_[A-Za-z0-9_]+)/.exec(String(e));
    if (m) return { journalEntryId: m[1]!, alreadyBooked: true };
    throw e;
  }
}
