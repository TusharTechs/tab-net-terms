import { readFileSync, statSync, unlinkSync } from "node:fs";
import { type AirwallexClient, AirwallexError } from "../airwallex/client.js";
import { createMandate, getCredentialToFile, reportResult } from "../airi/cli.js";
import { VIC_MAX_PER_TXN } from "../domain/credit.js";
import { type Cents, toMajor } from "../domain/money.js";

/**
 * "The card authorisation is the guarantee": a statement of up to US$200 is authorised (not
 * captured) on a passkey-approved Visa Intelligent Commerce credential when it is issued; at the
 * due date only the undisputed amount is captured (one authorisation, one capture, never split).
 * Card data is written by Airi to a 0600 file, read once here and deleted; it is never logged.
 */

export interface CardStatement {
  statementId: string;
  hash: string;
  total: Cents;
  lines: { name: string; amount: Cents }[];
  paymentIntentId: string;
  airiMandateId: string;
  passkeyUrl: string;
  authorised?: boolean;
  capturedAmount?: Cents;
}

export async function openCardStatement(
  awx: AirwallexClient,
  p: { statementId: string; hash: string; lines: { name: string; amount: Cents }[]; paymentMethodId: string; buyerAgent: string; merchantName: string; merchantUrl: string; buyerId?: string },
): Promise<CardStatement> {
  const total = p.lines.reduce((s, l) => s + l.amount, 0);
  if (total > VIC_MAX_PER_TXN) throw new Error("card statements are capped at $200; larger statements use the Metal statement mandate (never split)");
  for (const l of p.lines) if (/[,:]/.test(l.name)) throw new Error(`line name may not contain ',' or ':' (${l.name})`);
  // One statement, one payment intent: reuse it if a retry finds one already open for this statement.
  const existing = await awx.get<{ items?: { id: string; status: string }[] }>(`/pa/payment_intents?merchant_order_id=${encodeURIComponent(p.statementId)}`);
  const open = (existing.items ?? []).find((x) => x.status !== "CANCELLED");
  const pi = open ?? await awx.post<{ id: string }>("/pa/payment_intents/create", {
    request_id: `pi-${p.statementId}`,
    amount: Number(toMajor(total)),
    currency: "USD",
    merchant_order_id: p.statementId,
    metadata: { statement_hash: p.hash, rail: "VIC via Airi", guarantee: "authorise at issue, capture undisputed at due", ...(p.buyerId ? { buyer_id: p.buyerId } : {}) },
  });
  const m = await createMandate({
    source: p.buyerAgent,
    paymentMethodId: p.paymentMethodId,
    merchantName: p.merchantName,
    merchantUrl: p.merchantUrl,
    merchantCountry: "US",
    totalAmount: toMajor(total),
    currency: "USD",
    items: p.lines.map((l) => ({ name: l.name, unitPrice: toMajor(l.amount), quantity: 1 })),
    description: `Statement ${p.statementId} sha256 ${p.hash.slice(2, 18)}`,
  });
  const airiMandateId = String(m.mandateId ?? m.mandate_id);
  return { statementId: p.statementId, hash: p.hash, total, lines: p.lines, paymentIntentId: pi.id, airiMandateId, passkeyUrl: String(m.passkeyUrl ?? "") };
}

/** Waits for the passkey approval, then authorises the full statement without capturing. */
export async function authoriseCardStatement(awx: AirwallexClient, st: CardStatement, credFile: string): Promise<{ ok: boolean; status: string; reason?: string }> {
  await getCredentialToFile(st.airiMandateId, credFile);
  if ((statSync(credFile).mode & 0o777) !== 0o600) throw new Error("credential file must be 0600");
  try {
    const c = JSON.parse(readFileSync(credFile, "utf8")) as Record<string, string>;
    const year = String(c.expiryYear ?? "");
    const res = await awx.post<{ status: string; amount: number }>(`/pa/payment_intents/${st.paymentIntentId}/confirm`, {
      request_id: `confirm-${st.paymentIntentId}`,
      payment_method: { type: "card", card: { number: String(c.number), expiry_month: String(c.expiryMonth).padStart(2, "0"), expiry_year: year.length === 2 ? `20${year}` : year, cvc: String(c.cvv), name: "Buyer agent" } },
      payment_method_options: { card: { auto_capture: false, authorization_type: "pre_auth" } },
    });
    const ok = res.status === "REQUIRES_CAPTURE" && Math.round(res.amount * 100) === st.total;
    await reportResult(st.airiMandateId, ok ? "SUCCEEDED" : "DECLINED", ok ? undefined : `authorisation ${res.status}`);
    st.authorised = ok;
    return ok ? { ok, status: res.status } : { ok, status: res.status, reason: "authorised amount does not match the statement" };
  } finally {
    unlinkSync(credFile);
  }
}

/**
 * At the due date: capture exactly `amount`, which the desk computes as what is still owed after
 * credits (never more than the authorisation). Retries are safe: each call reads the payment first,
 * and its request id is derived from the payment, so a repeat can neither capture twice nor open a
 * second hold. Capturing 0 voids the authorisation.
 */
export async function captureCard(awx: AirwallexClient, st: CardStatement, amount: Cents): Promise<{ captured: Cents; status: string; alreadyDone: boolean }> {
  if (amount < 0 || amount > st.total) throw new Error(`capture ${amount} is outside the ${st.total} authorised`);
  const read = async () => awx.get<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${st.paymentIntentId}`);
  const now = await read();
  if (now.status === "SUCCEEDED" || now.status === "CANCELLED") return { captured: Math.round((now.captured_amount ?? 0) * 100), status: now.status, alreadyDone: true };
  try {
    if (amount === 0) {
      const v = await awx.post<{ status: string }>(`/pa/payment_intents/${st.paymentIntentId}/cancel`, { request_id: `cancel-${st.paymentIntentId}`, cancellation_reason: "whole statement disputed" });
      return { captured: 0, status: v.status, alreadyDone: false };
    }
    const r = await awx.post<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${st.paymentIntentId}/capture`, { request_id: `capture-${st.paymentIntentId}`, amount: Number(toMajor(amount)) });
    st.capturedAmount = amount;
    return { captured: Math.round((r.captured_amount ?? Number(toMajor(amount))) * 100), status: r.status, alreadyDone: false };
  } catch (e) {
    // The same request was already accepted (a retry after a lost response): report what Airwallex holds.
    if (e instanceof AirwallexError && e.code === "duplicate_request_id") {
      const r = await read();
      return { captured: Math.round((r.captured_amount ?? 0) * 100), status: r.status, alreadyDone: true };
    }
    throw e;
  }
}
