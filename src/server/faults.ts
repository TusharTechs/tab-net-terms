import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { AirwallexClient } from "../airwallex/client.js";
import { StandinBooks, T0Mcp } from "../books/books.js";
import { config } from "../config.js";
import { Desk, type DeskState, fileStore } from "../desk/desk.js";
import { NORTHWIND } from "../desk/northwind.js";
import { MetalAgent, usdzBalance } from "../metal/agent.js";
import { checkBooks, checkLive } from "../proof/checker.js";

/**
 * "Try to make TAB double-charge": live fault injection against the last collected statement.
 * Each attempt goes to Metal testnet for real; the buyer's on-chain balance is read before and
 * after, and the proof re-runs. Demo-only: the server enables it with ALLOW_FAULTS=1.
 */

export const FAULTS = {
  "same-id": "collect the paid statement again (same payment id)",
  "fresh-id": "collect it again under a fresh payment id",
  overcharge: "collect $1 more than the statement",
} as const;
export type Fault = keyof typeof FAULTS;

export async function runFault(fault: Fault, deskFile: string): Promise<{ ok: boolean; message: string }> {
  const cfg = config();
  const rpc = cfg.METAL_RPC_URL;
  if (!rpc) throw new Error("METAL_RPC_URL missing");
  const state = JSON.parse(readFileSync(deskFile, "utf8")) as DeskState;
  const target = Object.values(state.buyers)
    .flatMap((b) => (b.statements ?? []).filter((s) => s.status === "collected").map((s) => ({ b, s })))
    .at(-1);
  if (!target) return { ok: false, message: "no collected statement to attack yet: run the demo first" };
  const { b, s } = target;

  const desk = new Desk(state, {
    supplierPayee: NORTHWIND.supplier,
    refusalKey: NORTHWIND.supplierWalletKey,
    metal: new MetalAgent(),
    balanceOf: (a) => usdzBalance(rpc, a),
    books: new StandinBooks("fixtures/standin-books.json"),
    now: () => new Date(),
    persist: fileStore(deskFile).save,
  });

  const before = await usdzBalance(rpc, b.account);
  const fresh = `0x${randomBytes(32).toString("hex")}`;
  const res =
    fault === "same-id" ? await desk.collectStatement(b.id, s.id)
    : fault === "fresh-id" ? await desk.collectStatement(b.id, s.id, { paymentId: fresh })
    : await desk.collectStatement(b.id, s.id, { paymentId: fresh, amount: s.total + 100 });
  const after = await usdzBalance(rpc, b.account);

  const outcome = res.outcome === "paid" ? (res.alreadyPaid ? `the pull record answered "already paid" with the original tx ${res.tx.slice(0, 10)}…: nothing new was sent to the chain` : `PAID ${res.tx}`) : res.outcome === "refused" ? `chain refused: ${res.reason}${res.recordedTx ? " (refusal recorded on chain)" : ""}` : res.outcome;
  const moved = before - after;
  // The same full live proof the demo runs: chain receipts, Airwallex conversions and card captures, T:0 entries.
  const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });
  const t0 = cfg.T0_API_KEY ? new T0Mcp(cfg.T0_API_KEY) : undefined;
  const live = await checkLive(state, {
    receiptStatus: async (tx) => {
      const r = (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }) }).then((x) => x.json())) as { result?: { status?: string } };
      return r.result?.status ?? null;
    },
    conversionStatus: async (id) => (await awx.get<{ status: string }>(`/fx/conversions/${id}`)).status,
    paymentIntent: (id) => awx.get<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${id}`),
    ...(t0 ? { journalEntry: (id: string) => t0.call<{ total_debit_atoms: number; total_credit_atoms: number }>("get_one_journal_entry", { journal_entry_id: id }) } : {}),
  });
  const checks = [...checkBooks(state), ...live];
  const breaks = checks.filter((c) => !c.ok).length;
  const ok = moved === 0 && breaks === 0 && !(res.outcome === "paid" && !res.alreadyPaid);
  desk.recordProof(`after "${FAULTS[fault]}": ${outcome}; ${b.name}'s balance ${moved === 0 ? "did not move" : `moved by $${(moved / 100).toFixed(2)}`} ($${(before / 100).toFixed(2)} → $${(after / 100).toFixed(2)}) · ${checks.length - breaks}/${checks.length} checks pass`, checks);
  return { ok, message: outcome };
}
