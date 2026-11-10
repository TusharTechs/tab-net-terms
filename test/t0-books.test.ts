import { describe, expect, it } from "vitest";
import { bookCollection, RoutedBooks, T0Books, type T0Mcp, toInvoiceRecord } from "../src/books/books.js";

const inv = (id: string, status: string, due: string | null, paid: string | null, total: number, customer = "cust_a") => ({
  id: { externalId: id },
  data: { dueDate: due, paidDate: paid, status, total },
  links: [{ dataType: "Customer", externalId: customer }],
});

function fakeT0(pages: Record<string, any[]>, jeReply?: (body: any) => any) {
  const calls: { tool: string; args: any }[] = [];
  const t0 = {
    async call(tool: string, args: any) {
      calls.push({ tool, args });
      if (tool === "list_invoices") return { data: pages[args.status[0]] ?? [], next_cursor: null, as_of: "2026-11-10T00:00:00Z" };
      if (tool === "post_a_manual_journal_entry") return jeReply!(args.body);
      throw new Error(tool);
    },
  } as unknown as T0Mcp;
  return { t0, calls };
}

describe("T:0 books", () => {
  it("maps T:0 invoices: cents, due date, paid only when status is paid", () => {
    expect(toInvoiceRecord(inv("i1", "paid", "2026-09-01", "2026-08-31", 104.25))).toEqual({ id: "i1", amount: 10_425, dueDate: new Date("2026-09-01"), paidAt: new Date("2026-08-31") });
    expect(toInvoiceRecord(inv("i2", "open", "2026-10-18", null, 400)).paidAt).toBeUndefined();
  });

  it("caches only the mapped customer's dated invoices", async () => {
    const { t0 } = fakeT0({ paid: [inv("a1", "paid", "2026-09-01", "2026-09-01", 5), inv("b1", "paid", "2026-09-01", "2026-09-01", 9, "cust_b"), inv("a2", "paid", null, "2026-09-02", 7)], open: [inv("a3", "open", "2026-10-18", null, 40)] });
    const books = new T0Books(t0, { acme: "cust_a" });
    await books.refresh();
    expect((await books.invoicesFor("acme")).map((i) => i.id).sort()).toEqual(["a1", "a3"]);
    expect(await books.invoicesFor("globex")).toEqual([]);
  });

  it("routes each buyer to its books and reports the source per buyer", () => {
    const t0b = { source: "t0" as const, invoicesFor: async () => [] };
    const sb = { source: "standin" as const, invoicesFor: async () => [] };
    const r = new RoutedBooks({ acme: t0b }, sb);
    expect(r.sourceFor("acme")).toBe("t0");
    expect(r.sourceFor("globex")).toBe("standin");
  });

  it("books a collection as a balanced entry keyed by the Metal tx; a repeat returns the original entry", async () => {
    let seen: any;
    const { t0 } = fakeT0({}, (body) => ((seen = body), { id: "je_1", je_number: "JE-7" }));
    const p = { customerExternalId: "cust_a", amount: 1740, currency: "USD", metalTx: "0xabc", depositId: "dep_1", conversionId: "conv_1", date: new Date("2026-11-10") };
    expect(await bookCollection(t0, p)).toEqual({ journalEntryId: "je_1", jeNumber: "JE-7", alreadyBooked: false });
    expect(seen.idempotency_key).toBe("tab-collect-0xabc");
    const lines = seen.lines as any[];
    expect(lines.reduce((s, l) => s + (l.line_type === "debit" ? l.amount_atoms : -l.amount_atoms), 0)).toBe(0);
    expect(lines.find((l) => l.line_type === "credit").counterparty_external_id).toBe("cust_a");

    const dup = fakeT0({}, () => {
      throw new Error("T:0 post_a_manual_journal_entry: 409 CAPI34 X-Idempotency-Key has already been processed; it created je_prod_X1. Nothing was written again.");
    });
    expect(await bookCollection(dup.t0, p)).toEqual({ journalEntryId: "je_prod_X1", alreadyBooked: true });
  });
});

describe("T0Mcp retries", () => {
  const reply = (status: number, code: string) => new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ status, headers: {}, body: status < 400 ? { ok: true } : { error_code: code, detail: "x" } }) }] } })}\n`);
  it("retries a write-in-progress 409 but not an idempotency 409", async () => {
    const { vi } = await import("vitest");
    const { T0Mcp } = await import("../src/books/books.js");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(409, "CAPI02")).mockResolvedValueOnce(reply(200, ""));
    const p = new T0Mcp("k", "https://t0.example/mcp").call("list_invoices");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
    f.mockReset().mockResolvedValueOnce(reply(409, "CAPI34"));
    await expect(new T0Mcp("k", "https://t0.example/mcp").call("post_a_manual_journal_entry")).rejects.toThrow(/CAPI34/);
    expect(f).toHaveBeenCalledTimes(1);
    f.mockRestore();
    vi.useRealTimers();
  });
});
