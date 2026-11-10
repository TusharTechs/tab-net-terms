import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import type { DeskState } from "../src/desk/desk.js";
import { NORTHWIND } from "../src/desk/northwind.js";
import type { MandateStatus, PullOutcome } from "../src/metal/agent.js";
import { type FaultRails, runFault } from "../src/server/faults.js";

const NOW = Date.now();
const history = [1, 2, 3].map((i) => ({ id: `I${i}`, amount: 1, dueDate: new Date(NOW - i * 864e6), paidAt: new Date(NOW - i * 864e6 - 864e5) }));

/** Fake rails that behave like the chain: a pull moves the buyer's balance and the mandate's spent total. */
function rails() {
  const chain = { balance: 50_000, spent: 0, txs: [] as { tx: string; amount: number }[], pulls: 0 };
  const r: FaultRails = {
    metal: {
      status: async (): Promise<MandateStatus> => ({ mandateId: "0xline", bound: true, revoked: false, spent: chain.spent, budget: 40_000, payments: chain.txs.length, capPerPayment: 40_000, payees: [NORTHWIND.supplier] }),
      pull: async (p: { amount: number }): Promise<PullOutcome> => {
        chain.pulls++;
        chain.spent += p.amount;
        chain.balance -= p.amount;
        const tx = `0xtx${chain.pulls}`;
        chain.txs.push({ tx, amount: p.amount });
        return { outcome: "paid", tx, alreadyPaid: false, spent: "" };
      },
    },
    books: { source: "standin", invoicesFor: async () => history } satisfies Books,
    balanceOf: async () => chain.balance,
    findTransfer: async (p) => chain.txs.filter((t) => t.amount === p.amount && !(p.exclude ?? []).includes(t.tx)).at(-1)?.tx ?? null,
    liveChecks: async () => [],
  };
  return { r, chain };
}

function deskFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "tab-faults-")), "desk.json");
  const state: DeskState = { buyers: { acme: { id: "acme", name: "Acme", account: "0xA", credential: "line.json", mandateKeyFile: "k", vicSettledCount: 1, orders: [] } }, events: [] };
  writeFileSync(f, JSON.stringify(state));
  return f;
}

describe("fault: kill the desk mid-pull on the credit line", () => {
  it("the pull reaches the chain once; a statement can't take the order; after restart the desk takes it from the chain and sends nothing again", async () => {
    const { r, chain } = rails();
    const f = deskFile();
    const res = await runFault("crash", f, r);
    expect(res.ok).toBe(true);
    expect(chain.pulls).toBe(1);
    expect(chain.balance).toBe(50_000 - 2_000);
    const saved = JSON.parse(readFileSync(f, "utf8")) as DeskState;
    expect(saved.buyers.acme!.inflight).toBeUndefined();
    expect(saved.buyers.acme!.orders[0]!.collectedBy).toBe("0xtx1");
    expect(saved.events.some((e) => e.type === "collect" && /reconciled from the chain/.test(e.summary))).toBe(true);
    expect(saved.events.at(-1)).toMatchObject({ type: "proof", summary: expect.stringMatching(/Pulls sent: 1/) });
  });

  it("without the chain lookup it would refuse to guess: the pull goes to a person, never re-sent", async () => {
    const { r, chain } = rails();
    r.findTransfer = async () => null;
    const res = await runFault("crash", deskFile(), r);
    expect(res.ok).toBe(false);
    expect(chain.pulls).toBe(1);
  });
});
