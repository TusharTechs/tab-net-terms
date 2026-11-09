import type { Cents } from "../domain/money.js";

/**
 * Dispute decisions are made here, in code, from the supplier's own order records.
 * The model only extracts what the customer claims (see reader.ts); it never sets an amount.
 */

export type ClaimType = "price_not_agreed" | "data_quality" | "not_ordered" | "other";

export interface Claim {
  type: ClaimType;
  orderIds: string[];
  /** Units the customer says are affected (data_quality), if stated. */
  units?: number;
  /** Customer's own words, quoted. */
  quote: string;
}

/** What the desk knows about an order, independent of anything the customer says. */
export interface OrderEvidence {
  id: string;
  /** Price route the buyer agent ordered under, e.g. "/v2/query". */
  priceRoute: string;
  /** Unit price on that route, in cents. */
  unitPrice: Cents;
  units: number;
  /** Units the supplier's own delivery QA flagged as stale or wrong. */
  staleUnits: number;
  /** Proof the buyer's agent placed it at that price: signed offer, tx hash, or order record id. */
  proof: string;
  /** Amount already credited on this order. */
  credited: Cents;
}

export type Finding =
  | { claim: ClaimType; orderId: string; verdict: "upheld_for_supplier"; reason: string; proof: string }
  | { claim: ClaimType; orderId: string; verdict: "credit"; amount: Cents; reason: string }
  | { claim: ClaimType; orderId: string | null; verdict: "escalate"; reason: string };

export interface DisputeDecision {
  findings: Finding[];
  totalCredit: Cents;
}

export function decideDispute(claims: Claim[], orders: Map<string, OrderEvidence>): DisputeDecision {
  const findings: Finding[] = [];
  const creditedHere = new Map<string, Cents>();

  for (const c of claims) {
    if (c.type === "other" || c.orderIds.length === 0) {
      findings.push({ claim: c.type, orderId: c.orderIds[0] ?? null, verdict: "escalate", reason: `needs a person: "${c.quote.slice(0, 120)}"` });
      continue;
    }
    for (const id of c.orderIds) {
      const o = orders.get(id);
      if (!o) {
        findings.push({ claim: c.type, orderId: id, verdict: "escalate", reason: `no order ${id} on record` });
        continue;
      }
      if (c.type === "price_not_agreed" || c.type === "not_ordered") {
        findings.push({
          claim: c.type,
          orderId: id,
          verdict: "upheld_for_supplier",
          reason: c.type === "price_not_agreed" ? `ordered on ${o.priceRoute} at ${o.unitPrice}¢/unit × ${o.units}` : `buyer agent placed it (${o.units} units on ${o.priceRoute})`,
          proof: o.proof,
        });
        continue;
      }
      // data_quality: credit only units our own QA flagged, never more than the customer claims, never twice.
      const alreadyCreditedUnits = Math.floor((o.credited + (creditedHere.get(id) ?? 0)) / o.unitPrice);
      const staleLeft = Math.max(0, o.staleUnits - alreadyCreditedUnits);
      const units = Math.min(c.units ?? staleLeft, staleLeft);
      const amount = units * o.unitPrice;
      if (amount > 0) {
        creditedHere.set(id, (creditedHere.get(id) ?? 0) + amount);
        findings.push({ claim: c.type, orderId: id, verdict: "credit", amount, reason: `${units} stale unit(s) confirmed by delivery QA × ${o.unitPrice}¢` });
      } else {
        findings.push({ claim: c.type, orderId: id, verdict: "upheld_for_supplier", reason: o.staleUnits === 0 ? "delivery QA flagged no stale units" : "already credited", proof: o.proof });
      }
    }
  }
  return { findings, totalCredit: [...creditedHere.values()].reduce((a, b) => a + b, 0) };
}
