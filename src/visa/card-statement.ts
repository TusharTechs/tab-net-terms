import { readFileSync, statSync, unlinkSync } from "node:fs";
import { type AirwallexClient, newRequestId } from "../airwallex/client.js";
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
  p: { statementId: string; hash: string; lines: { name: string; amount: Cents }[]; paymentMethodId: string; buyerAgent: string; merchantName: string; merchantUrl: string },
): Promise<CardStatement> {
  const total = p.lines.reduce((s, l) => s + l.amount, 0);
  if (total > VIC_MAX_PER_TXN) throw new Error("card statements are capped at $200; larger statements use the Metal statement mandate (never split)");
  for (const l of p.lines) if (/[,:]/.test(l.name)) throw new Error(`line name may not contain ',' or ':' (${l.name})`);
  const pi = await awx.post<{ id: string }>("/pa/payment_intents/create", {
    request_id: newRequestId(),
    amount: Number(toMajor(total)),
    currency: "USD",
    merchant_order_id: p.statementId,
    metadata: { statement_hash: p.hash, rail: "VIC via Airi", guarantee: "authorise at issue, capture undisputed at due" },
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
      request_id: newRequestId(),
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

/** At the due date: capture only what is not disputed. The rest of the authorisation lapses. */
export async function captureUndisputed(awx: AirwallexClient, st: CardStatement, disputed: Cents): Promise<{ captured: Cents; status: string }> {
  const amount = st.total - Math.max(0, Math.min(disputed, st.total));
  if (amount <= 0) {
    const v = await awx.post<{ status: string }>(`/pa/payment_intents/${st.paymentIntentId}/cancel`, { request_id: newRequestId(), cancellation_reason: "whole statement disputed" });
    return { captured: 0, status: v.status };
  }
  const r = await awx.post<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${st.paymentIntentId}/capture`, { request_id: newRequestId(), amount: Number(toMajor(amount)) });
  st.capturedAmount = amount;
  return { captured: Math.round((r.captured_amount ?? Number(toMajor(amount))) * 100), status: r.status };
}
