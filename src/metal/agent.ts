import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { MandateView } from "../domain/credit.js";
import { type Cents, fromMajor } from "../domain/money.js";

/**
 * Wrapper over the `metal-agent` CLI (0.3.3). It prints "key value" lines, no JSON, so this
 * module parses those lines. A non-zero exit is not always an error: a refused pull exits 1
 * with a normal report on stdout.
 */

const run = promisify(execFile);
const BIN = resolve("node_modules/.bin/metal-agent");

export interface CliResult {
  stdout: string;
  code: number;
}

export type Runner = (args: string[]) => Promise<CliResult>;

export const cliRunner: Runner = async (args) => {
  try {
    const { stdout } = await run(BIN, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: process.env });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    if (typeof err.stdout === "string" && err.stdout.trim()) return { stdout: err.stdout, code: err.code ?? 1 };
    throw new Error(`metal-agent ${args.slice(0, 2).join(" ")} failed: ${(err.stderr ?? String(e)).trim().slice(0, 300)}`);
  }
};

/** "key rest of line" → map; repeated keys (payee) collected in `multi`. */
export function parseKv(stdout: string): { one: Record<string, string>; multi: Record<string, string[]> } {
  const one: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const line of stdout.split("\n")) {
    const m = /^([a-z][a-z0-9-]*) (.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m as unknown as [string, string, string];
    (multi[k] ??= []).push(v);
    one[k] ??= v;
  }
  return { one, multi };
}

/** "1.8 *USDZ" → 180 */
const usdz = (s: string | undefined): Cents => fromMajor((s ?? "0").split(" ")[0]!);

export interface MandateStatus extends MandateView {
  mandateId: string;
  bound: boolean;
  payments: number;
  capPerPayment: Cents;
}

export function parseStatus(stdout: string): MandateStatus {
  const { one, multi } = parseKv(stdout);
  const spent = /^([\d.]+) \*USDZ of ([\d.]+) \*USDZ/.exec(one.spent ?? "");
  const expiry = /^(\d+)/.exec(one.expiry ?? "");
  return {
    mandateId: one.mandate ?? "",
    bound: one.bound === "yes",
    revoked: one.revoked === "yes",
    spent: spent ? fromMajor(spent[1]!) : 0,
    budget: spent ? fromMajor(spent[2]!) : usdz(one.budget),
    payments: Number(one.payments ?? 0),
    capPerPayment: usdz(one["per-payment-cap"]),
    payees: (multi.payee ?? []).map((p) => p.split(" ")[0]!),
    ...(expiry ? { expiresAt: new Date(Number(expiry[1]) * 1000) } : {}),
  };
}

export type PullOutcome =
  | { outcome: "paid"; tx: string; alreadyPaid: boolean; spent: string }
  | { outcome: "refused"; reason: string; detail: string; /** set when the refusal was recorded on chain */ recordedTx?: string }
  | { outcome: "pending" | "held"; tx?: string };

export function parsePull(stdout: string): PullOutcome {
  const { one } = parseKv(stdout);
  const outcome = one.outcome ?? "";
  if (outcome.startsWith("paid")) return { outcome: "paid", tx: one.transaction ?? "", alreadyPaid: /already paid/.test(stdout), spent: one.spent ?? "" };
  if (outcome.startsWith("refused")) {
    const r = /^(\S+)\s*(?:\((.*)\))?/.exec(one.reason ?? "");
    return { outcome: "refused", reason: r?.[1] ?? "unknown", detail: r?.[2] ?? "", ...(one.transaction ? { recordedTx: one.transaction } : {}) };
  }
  if (outcome.startsWith("held")) return { outcome: "held", ...(one.transaction ? { tx: one.transaction } : {}) };
  return { outcome: "pending", ...(one.transaction ? { tx: one.transaction } : {}) };
}

const net = (network: string) => ["--network", network];

export class MetalAgent {
  constructor(
    private readonly network = "testnet",
    private readonly runner: Runner = cliRunner,
  ) {}

  async status(credential: string): Promise<MandateStatus> {
    const r = await this.runner(["mandate", "status", "--credential", credential, ...net(this.network)]);
    return parseStatus(r.stdout);
  }

  /** Supplier collects from the buyer's mandate. `paymentId` makes a retry pay at most once. */
  /**
   * Supplier collects from the buyer's mandate. `paymentId` makes a retry pay at most once.
   * With `recordRefusalKey` (a funded key that pays gas), a refused pull is still sent so the
   * refusal is recorded on chain.
   */
  async pull(p: { credential: string; mandateKeyFile: string; to: string; amount: Cents; paymentId: string; recordRefusalKey?: string }): Promise<PullOutcome> {
    const r = await this.runner([
      "mandate", "pull",
      "--credential", p.credential,
      "--mandate-key-file", p.mandateKeyFile,
      "--to", p.to,
      "--amount", (p.amount / 100).toFixed(2),
      "--payment-id", p.paymentId,
      ...(p.recordRefusalKey ? ["--key", p.recordRefusalKey, "--record-refusal"] : []),
      ...net(this.network),
    ]);
    return parsePull(r.stdout);
  }

  /** Supplier issues a debit-mandate credential naming itself as payee, signed with its own issuer key. */
  async issueCredential(p: {
    principal: string; cap: Cents; budget: Cents; payee: string; payeeLabel: string; issuerKey: string; out: string; description: string; mandateKeyFile?: string;
    /** Seconds from now until the mandate can be collected (a statement's due date). */
    startsIn?: number;
    /** Seconds from now until it can no longer be collected (due date + grace). */
    expiresIn?: number;
    maxOccurrences?: number;
  }) {
    const r = await this.runner([
      "mandate", "credential", "create",
      "--principal", p.principal,
      "--cap", (p.cap / 100).toFixed(2),
      "--budget", (p.budget / 100).toFixed(2),
      "--issuer-key", p.issuerKey,
      "--payee", `${p.payee},${p.payeeLabel}`,
      "--description", p.description,
      "--out", p.out,
      ...(p.mandateKeyFile ? ["--mandate-key-file", p.mandateKeyFile] : []),
      ...(p.startsIn !== undefined ? ["--starts-in", String(Math.max(0, Math.round(p.startsIn)))] : []),
      ...(p.expiresIn !== undefined ? ["--expires-in", String(Math.round(p.expiresIn))] : []),
      ...(p.maxOccurrences !== undefined ? ["--max-occurrences", String(p.maxOccurrences)] : []),
      ...net(this.network),
    ]);
    const { one } = parseKv(r.stdout);
    const ts = (k: string) => { const m = /^(\d+)/.exec(one[k] ?? ""); return m ? new Date(Number(m[1]) * 1000).toISOString() : undefined; };
    return { mandateId: one.mandate ?? "", mandateKeyFile: (one["mandate-key-file"] ?? "").split(" ")[0]!, startsAt: ts("starts"), expiresAt: ts("expiry") };
  }

  /** Creates (or names, if it exists) the owner's smart account. The owner key is funded for gas from the faucet. */
  async createAccount(ownerKey: string, existing: boolean) {
    const r = await this.runner(["account", "create", existing ? "--key" : "--out", ownerKey, ...net(this.network)]);
    const { one } = parseKv(r.stdout);
    if (!one.account) throw new Error(`account create failed: ${r.stdout.trim().slice(0, 300)}`);
    return { account: one.account, owner: one.owner ?? "", tx: one.transaction };
  }

  /** Testnet faucet; waits out its per-client rate limit (it says how long) up to `tries` times. */
  async fund(address: string, tries = 4): Promise<{ tx: string }> {
    for (let i = 0; ; i++) {
      try {
        const r = await this.runner(["fund", address, ...net(this.network)]);
        return { tx: parseKv(r.stdout).one.transaction ?? "" };
      } catch (e) {
        const wait = /retry in (\d+) s/.exec(String(e));
        if (!wait || i >= tries) throw e;
        await new Promise((res) => setTimeout(res, (Number(wait[1]) + 2) * 1000));
      }
    }
  }

  /** Buyer's owner binds (or replaces) a supplier-issued credential, trusting only that supplier's issuer. */
  async bind(p: { credential: string; ownerKey: string; issuerPublic: string; replaces?: string }) {
    const args = p.replaces
      ? ["mandate", "replace", "--credential", p.credential, "--replaces", p.replaces]
      : ["mandate", "bind", "--credential", p.credential];
    const r = await this.runner([...args, "--key", p.ownerKey, "--issuer", p.issuerPublic, ...net(this.network)]);
    const { one } = parseKv(r.stdout);
    if (r.code !== 0 || !one.transaction) throw new Error(`bind failed: ${r.stdout.trim().slice(0, 300)}`);
    return { tx: one.transaction, mandateId: one.bound ?? "" };
  }
}

export const USDZ = "0x000000000000000000000000000000000000B5d5";

/** USDZ balance of an address via eth_call balanceOf. 18 decimals → whole cents (rounded down). */
export async function usdzBalance(rpcUrl: string, address: string, fetchImpl: typeof fetch = fetch): Promise<Cents> {
  const data = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDZ, data }, "latest"] }),
  });
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (!json.result) throw new Error(`balanceOf failed: ${json.error?.message ?? res.status}`);
  return Number(BigInt(json.result) / 10n ** 16n);
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Finds a USDZ transfer of exactly `amount` from `from` to `to` in the last `lookback` blocks, by its
 * Transfer log. Used to reconcile a pull whose outcome was lost (crash, timeout) before re-sending it.
 */
export async function findTransfer(rpcUrl: string, p: { from: string; to: string; amount: Cents; lookback?: number; exclude?: string[] }, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error || json.result === undefined) throw new Error(`${method} failed: ${json.error?.message ?? res.status}`);
    return json.result;
  };
  const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const latest = Number(BigInt(await call<string>("eth_blockNumber", [])));
  const fromBlock = Math.max(0, latest - Math.min(p.lookback ?? 90_000, 99_000)); // the RPC caps one query at 100,000 blocks (~100 min on testnet)
  const logs = await call<{ transactionHash: string; data: string }[]>("eth_getLogs", [{ address: USDZ, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: "latest", topics: [TRANSFER_TOPIC, pad(p.from), pad(p.to)] }]);
  const want = BigInt(p.amount) * 10n ** 16n;
  const skip = new Set((p.exclude ?? []).map((t) => t.toLowerCase()));
  const hit = logs.filter((l) => BigInt(l.data.slice(0, 66)) === want && !skip.has(l.transactionHash.toLowerCase())).at(-1);
  return hit?.transactionHash ?? null;
}

/** A transaction receipt (status, sender, logs), for the proof's live checks. */
export async function txReceipt(rpcUrl: string, tx: string, fetchImpl: typeof fetch = fetch): Promise<{ status: string; from: string; logs: { address: string; topics: string[]; data: string }[] } | null> {
  const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }) });
  const json = (await res.json()) as { result?: { status: string; from: string; logs: { address: string; topics: string[]; data: string }[] } | null };
  return json.result ?? null;
}
