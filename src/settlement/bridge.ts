import { type AirwallexClient, AirwallexError, newRequestId } from "../airwallex/client.js";
import { type Cents, toMajor } from "../domain/money.js";
import type { SettlementLedger, SettlementRecord, SettlementState } from "../ledger/settlements.js";

/**
 * Moves money collected on Metal into Airwallex and converts the part not held back.
 *
 * The Airwallex sandbox cannot receive stablecoins, so the off-ramp is a deposit
 * SIMULATION into the supplier's USD Global Account: the only simulated step, labelled.
 * Double-credit protection is TAB's own ledger (see ledger/settlements.ts), keyed by the
 * Metal tx hash, because the sandbox accepts repeated deposits with the same reference.
 */

export interface CollectionToSettle {
  /** Metal transaction hash of the pull that collected the money. */
  metalTxHash: string;
  /** USDZ collected, in cents (1 USDZ = 1 USD). */
  amount: Cents;
  /** Who paid, for the statement. */
  payerName: string;
}

export interface SettlementPolicy {
  /** Share of each collection kept in USD for refunds, in basis points (500 = 5%). */
  refundReserveBps: number;
  targetCurrency: string;
  /** Conversions above this need a person's approval bound to the exact quote. */
  approvalThreshold: Cents;
  quoteValidity: "MIN_1" | "MIN_15" | "MIN_30" | "HR_1";
}

export const DEFAULT_SETTLEMENT_POLICY: SettlementPolicy = {
  refundReserveBps: 500,
  targetCurrency: "SGD",
  approvalThreshold: 100_000, // $1,000
  quoteValidity: "MIN_15",
};

export interface Quote {
  quote_id: string;
  client_rate: number;
  sell_amount: number;
  buy_amount: number;
  sell_currency: string;
  buy_currency: string;
  valid_to_at: string;
}

/** What the approver is shown, and the only thing an approval can authorise. */
export interface ConversionApprovalRequest {
  quoteId: string;
  sell: string;
  buy: string;
  rate: number;
  validTo: string;
}

/** Returns true to approve. Bound to one quote: a new quote needs a new approval. */
export type Approver = (req: ConversionApprovalRequest) => Promise<boolean>;

export type SettlementOutcome =
  | { kind: "converted"; depositId: string; reserved: Cents; quote: Quote; conversionId: string; conversionStatus: string; requestId: string; approvedBy: "policy" | "person" }
  | { kind: "deposited_only"; depositId: string; reason: "nothing_to_convert" | "below_fx_minimum" | "approval_declined" | "quote_expired"; reserved: Cents; quote?: Quote }
  | { kind: "already_settled"; record: SettlementRecord };

interface Deposit {
  id: string;
  status: string;
  amount: number;
  currency: string;
  reference?: string;
}

const referenceFor = (txHash: string) => `Metal USDZ collection ${txHash}`;

/** After a crash between "deposit_pending" and "deposited": was the deposit actually made? */
async function findDepositByTx(awx: AirwallexClient, txHash: string): Promise<Deposit | undefined> {
  const res = await awx.get<{ items: Deposit[] }>("/deposits", { query: { page_num: 0, page_size: 100 } });
  return res.items.find((d) => d.reference === referenceFor(txHash));
}

export async function settleCollection(
  awx: AirwallexClient,
  ledger: SettlementLedger,
  usdGlobalAccountId: string,
  c: CollectionToSettle,
  approve: Approver,
  policy: SettlementPolicy = DEFAULT_SETTLEMENT_POLICY,
  now: () => Date = () => new Date(),
): Promise<SettlementOutcome> {
  const save = (s: SettlementState) => ledger.put({ metalTxHash: c.metalTxHash, amount: c.amount, updatedAt: now().toISOString(), ...s });

  const existing = ledger.get(c.metalTxHash);

  // Crashed mid-conversion: retry with the SAME request_id, so it can only ever book once.
  if (existing?.state === "converting") {
    try {
      const conv = await awx.post<{ conversion_id: string; status: string }>("/fx/conversions/create", {
        request_id: existing.requestId,
        quote_id: existing.quoteId,
        sell_currency: "USD",
        buy_currency: policy.targetCurrency,
        sell_amount: toMajor(c.amount - Math.ceil((c.amount * policy.refundReserveBps) / 10_000)),
      });
      save({ state: "converted", depositId: existing.depositId, quoteId: existing.quoteId, requestId: existing.requestId, conversionId: conv.conversion_id });
    } catch (e) {
      if (!(e instanceof AirwallexError && e.code === "duplicate_request_id")) throw e;
      // Booked by the crashed run; Airwallex refused the second booking. Id is findable by request_id.
      save({ state: "converted", depositId: existing.depositId, quoteId: existing.quoteId, requestId: existing.requestId, conversionId: `see request_id ${existing.requestId}` });
    }
    return { kind: "already_settled", record: ledger.get(c.metalTxHash)! };
  }
  if (existing && existing.state !== "deposit_pending") return { kind: "already_settled", record: existing };

  // 1. Off-ramp (SIMULATED). Mark pending first; if a previous run crashed here, look before depositing again.
  let depositId: string | undefined;
  if (existing?.state === "deposit_pending") depositId = (await findDepositByTx(awx, c.metalTxHash))?.id;
  if (!depositId) {
    save({ state: "deposit_pending" });
    const dep = await awx.post<Deposit>("/simulation/deposit/create", {
      global_account_id: usdGlobalAccountId,
      amount: Number(toMajor(c.amount)),
      payer_name: c.payerName,
      reference: referenceFor(c.metalTxHash),
    });
    depositId = dep.id;
  }
  save({ state: "deposited", depositId });

  // 2. Keep the refund reserve in USD; convert only the rest. Reserve rounds UP so it is never short.
  const reserved = Math.ceil((c.amount * policy.refundReserveBps) / 10_000);
  const toConvert = c.amount - reserved;
  const hold = (reason: "nothing_to_convert" | "below_fx_minimum" | "approval_declined" | "quote_expired", quote?: Quote): SettlementOutcome => {
    save({ state: "held_usd", depositId: depositId!, reason });
    return { kind: "deposited_only", depositId: depositId!, reason, reserved, ...(quote ? { quote } : {}) };
  };
  if (toConvert <= 0) return hold("nothing_to_convert");

  // 3. Lock a quote. Amounts under Airwallex's FX minimum stay in USD for a later, larger sweep.
  let quote: Quote;
  try {
    quote = await awx.post<Quote>("/fx/quotes/create", {
      sell_currency: "USD",
      buy_currency: policy.targetCurrency,
      sell_amount: Number(toMajor(toConvert)),
      validity: policy.quoteValidity,
    });
  } catch (e) {
    if (e instanceof AirwallexError && /amount_below_limit/.test(e.message)) return hold("below_fx_minimum");
    throw e;
  }

  // 4. Approval, bound to this quote id and only while it is valid.
  let approvedBy: "policy" | "person" = "policy";
  if (toConvert > policy.approvalThreshold) {
    const ok = await approve({
      quoteId: quote.quote_id,
      sell: `${toMajor(toConvert)} USD`,
      buy: `${quote.buy_amount} ${quote.buy_currency}`,
      rate: quote.client_rate,
      validTo: quote.valid_to_at,
    });
    if (!ok) return hold("approval_declined", quote);
    approvedBy = "person";
  }
  if (now().getTime() > Date.parse(quote.valid_to_at)) return hold("quote_expired", quote);

  // 5. Book the conversion. The request_id is saved before the call, so a retry reuses it
  //    and Airwallex rejects a second booking as duplicate_request_id.
  const requestId = newRequestId();
  save({ state: "converting", depositId, quoteId: quote.quote_id, requestId });
  const conv = await awx.post<{ conversion_id: string; status: string }>("/fx/conversions/create", {
    request_id: requestId,
    quote_id: quote.quote_id,
    sell_currency: "USD",
    buy_currency: policy.targetCurrency,
    sell_amount: toMajor(toConvert),
  });
  save({ state: "converted", depositId, quoteId: quote.quote_id, requestId, conversionId: conv.conversion_id });

  return { kind: "converted", depositId, reserved, quote, conversionId: conv.conversion_id, conversionStatus: conv.status, requestId, approvedBy };
}
