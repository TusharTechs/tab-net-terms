import { describe, expect, it } from "vitest";
import { resolveT0Customers, type T0Mcp } from "../src/books/books.js";
import { deskBooks } from "../src/books/desk-books.js";
import { billPaymentRecord, customerPaymentRecord, customerRecord, invoiceRecords, vendorBillRecord, vendorRecord } from "../src/books/t0records.js";
import { BUYERS, T0_BUYERS } from "../src/desk/northwind.js";
import { recordBillPayment } from "../src/payout/vendor.js";

const inv = (id: string, status: string, due: string, paid: string | null, total: number, customer: string) => ({
  id: { externalId: id },
  data: { dueDate: due, paidDate: paid, status, total },
  links: [{ dataType: "Customer", externalId: customer }],
});

/** A T:0 that returns the given customers (by our platform id) and invoices. */
function fakeT0(customers: Record<string, string>, invoices: ReturnType<typeof inv>[]) {
  const calls: { tool: string; args: any }[] = [];
  const t0 = {
    async call(tool: string, args: any) {
      calls.push({ tool, args });
      if (tool === "list_customers") return { data: (args.platform_object_ids as string[]).filter((p) => customers[p]).map((p) => ({ id: { externalId: customers[p] }, data: { customFields: { t0_platform_object_id: p } } })) };
      if (tool === "list_invoices") return { data: invoices.filter((i) => i.data.status === args.status[0]), next_cursor: null };
      if (tool === "create_records") return { received: args.body.length, inserted: args.body.length, duplicates: 0 };
      throw new Error(tool);
    },
  } as unknown as T0Mcp;
  return { t0, calls };
}

describe("records written into T:0", () => {
  it("an invoice's external totals equal its totals (T:0 refuses a mismatch), in dollars", () => {
    const [i] = invoiceRecords({ id: "x", customerId: "c", amountCents: 40_000, issued: "2026-09-18", due: "2026-10-18", memo: "m" });
    expect(i!.data).toMatchObject({ subtotal: 400, externalSubtotal: 400, total: 400, externalTotal: 400, tax: 0, status: "open", paidDate: null, issuedDate: "2026-09-18", date: "2026-09-18" });
    expect(i!.links).toEqual([{ dataType: "Customer", externalId: "c" }]);
  });

  it("a paid invoice comes with the payment that settled it, linked to the customer and the invoice", () => {
    const recs = invoiceRecords({ id: "x", customerId: "c", amountCents: 6_000, issued: "2026-08-21", due: "2026-09-20", paidAt: "2026-09-25", memo: "m" });
    expect(recs.map((r) => r.id.dataType)).toEqual(["Invoice", "Payment"]);
    expect(recs[0]!.data).toMatchObject({ status: "paid", paidDate: "2026-09-25" });
    expect(recs[1]!.data).toMatchObject({ amount: 60, status: "succeeded", succeededDate: "2026-09-25" });
    expect(recs[1]!.links).toEqual([{ dataType: "Customer", externalId: "c" }, { dataType: "Invoice", externalId: "x" }]);
  });

  it("a payment applied to no invoice links only to the customer, so it adds no invoice history", () => {
    const p = customerPaymentRecord({ id: "p", customerId: "c", amountCents: 8_000, date: "2026-11-10", description: "d", customFields: { metal_tx: "0x1" } });
    expect(p.id.dataType).toBe("Payment");
    expect(p.links).toEqual([{ dataType: "Customer", externalId: "c" }]);
    expect(p.data).toMatchObject({ amount: 80, status: "succeeded", customFields: { metal_tx: "0x1" } });
  });

  it("a demo bill is open, in dollars, numbered, and owed to our own vendor record", () => {
    expect(vendorRecord("tab-vendor-slack", "Slack Technologies, Inc.", "2026-10-01").id).toEqual({ dataType: "Vendor", externalId: "tab-vendor-slack" });
    const b = vendorBillRecord({ id: "b", vendorId: "tab-vendor-slack", number: "SLK-1", amountCents: 15_000, date: "2026-10-20", due: "2026-11-04", memo: "m" });
    expect(b.data).toMatchObject({ status: "open", total: 150, subtotal: 150, tax: 0, dueDate: "2026-11-04", customFields: { bill_number: "SLK-1" } });
    expect(b.links).toEqual([{ dataType: "Vendor", externalId: "tab-vendor-slack" }]);
  });

  it("no reserved t0_ custom fields are submitted", () => {
    const all = [customerRecord("c", "n", "e@example.com", "2026-08-15"), ...invoiceRecords({ id: "x", customerId: "c", amountCents: 1, issued: "2026-08-21", due: "2026-09-20", paidAt: "2026-09-25", memo: "m" }), billPaymentRecord({ billExternalId: "b", vendorExternalId: "v", amountCents: 10_000, date: "2026-11-10", transferId: "t", shortRef: "P1" })];
    for (const r of all) expect(Object.keys((r.data.customFields as object) ?? {}).filter((k) => k.startsWith("t0_"))).toEqual([]);
  });

  it("the bill payment has a fixed id per bill, so paying the same bill again replaces it rather than adding one", async () => {
    const { t0, calls } = fakeT0({}, []);
    const bill = { id: "t0_bill_1", number: "INV-1", vendorId: "t0_vendor_1", vendorName: "Slack", currency: "USD", amount: 10_000, dueDate: "2026-03-16" };
    const a = await recordBillPayment(t0, { bill, transferId: "tr1", shortRef: "P1", date: new Date("2026-11-10") });
    const b = await recordBillPayment(t0, { bill, transferId: "tr1", shortRef: "P1", date: new Date("2026-11-10") });
    expect(a).toBe(b);
    const rec = calls[0]!.args.body[0];
    expect(rec).toMatchObject({ id: { dataType: "BillPayment" }, data: { amount: 100, currencyCode: "USD", type: "bill", customFields: { airwallex_transfer_id: "tr1" } } });
    expect(rec.links).toEqual([{ dataType: "VendorBill", externalId: "t0_bill_1" }, { dataType: "Vendor", externalId: "t0_vendor_1" }]);
  });
});

describe("the desk's books per buyer", () => {
  it("finds T:0's id for a customer we submitted, by our own id; leaves out ones T:0 does not return", async () => {
    const { t0 } = fakeT0({ "tab-cust-initech": "t0_customer_9" }, []);
    expect(await resolveT0Customers(t0, { initech: "tab-cust-initech", globex: "tab-cust-globex" })).toEqual({ initech: "t0_customer_9" });
  });

  it("reads Initech from T:0 once T:0 returns it; Globex reads as T:0 with no history", async () => {
    const { t0 } = fakeT0({ [T0_BUYERS.initech]: "t0_customer_9" }, [inv("i1", "open", "2026-10-18", null, 400, "t0_customer_9"), inv("a1", "paid", "2026-08-05", "2026-08-05", 10, BUYERS.acme.t0Customer)]);
    const { books, t0Customers } = await deskBooks(t0, "fixtures/standin-books.json");
    expect(t0Customers).toEqual({ acme: BUYERS.acme.t0Customer, initech: "t0_customer_9" });
    expect(books.sourceFor!("initech")).toBe("t0");
    expect((await books.invoicesFor("initech")).map((i) => i.amount)).toEqual([40_000]);
    expect(books.sourceFor!("globex")).toBe("t0");
    expect(await books.invoicesFor("globex")).toEqual([]);
  });

  it("falls back to the labelled stand-in for Initech while T:0 does not return it, and with no T:0 key", async () => {
    const { t0 } = fakeT0({}, []);
    const { books } = await deskBooks(t0, "fixtures/standin-books.json");
    expect(books.sourceFor!("initech")).toBe("standin");
    expect((await books.invoicesFor("initech")).length).toBe(2);
    const none = await deskBooks(undefined, "fixtures/standin-books.json");
    expect(none.books.source).toBe("standin");
    expect(none.t0Customers).toEqual({});
  });
});
