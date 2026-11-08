import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cents } from "../domain/money.js";

/**
 * TAB's own record of every Metal collection it has moved into Airwallex.
 *
 * This ledger, not Airwallex, is what stops one on-chain collection from being credited
 * twice: the sandbox accepts repeated deposits with the same reference and does not keep
 * statement_ref (checked live on 2026-11-08). Every state is written BEFORE the call that
 * could change it, so a crash leaves a "pending" mark the next run reconciles first.
 */

export type SettlementState =
  | { state: "deposit_pending" }
  | { state: "deposited"; depositId: string }
  | { state: "converting"; depositId: string; quoteId: string; requestId: string }
  | { state: "converted"; depositId: string; quoteId: string; requestId: string; conversionId: string }
  | { state: "held_usd"; depositId: string; reason: string };

export type SettlementRecord = { metalTxHash: string; amount: Cents; updatedAt: string } & SettlementState;

export interface SettlementLedger {
  get(metalTxHash: string): SettlementRecord | undefined;
  put(record: SettlementRecord): void;
  all(): SettlementRecord[];
}

const key = (h: string) => h.toLowerCase();

export class InMemoryLedger implements SettlementLedger {
  protected rows = new Map<string, SettlementRecord>();
  get(h: string) {
    return this.rows.get(key(h));
  }
  put(r: SettlementRecord) {
    this.rows.set(key(r.metalTxHash), r);
  }
  all() {
    return [...this.rows.values()];
  }
}

/** JSON file ledger. Writes go to a temp file and are renamed into place, so a crash never leaves half a file. */
export class FileLedger extends InMemoryLedger {
  constructor(private readonly path: string) {
    super();
    try {
      const rows = JSON.parse(readFileSync(path, "utf8")) as SettlementRecord[];
      for (const r of rows) this.rows.set(key(r.metalTxHash), r);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  override put(r: SettlementRecord) {
    super.put(r);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    renameSync(tmp, this.path);
  }
}
