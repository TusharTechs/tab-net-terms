/**
 * Writes the demo buyers' books into the T:0 sandbox, replacing the local stand-in:
 * Initech's history (one invoice paid 5 days late, one $400 invoice overdue since Oct 18) and
 * Globex as a customer with no invoices. Optionally records the bill payment for the vendor bill
 * TAB paid by Airwallex transfer. Fixed ids, so a re-run replaces rather than duplicates.
 *   npx tsx scripts/t0-seed-buyers.ts [--bill-payment]
 * T:0 reads these back through its API after its next nightly run (see src/books/t0records.ts).
 */
import { T0Mcp } from "../src/books/books.js";
import { billPaymentRecord, customerRecord, invoiceRecords, submitRecords } from "../src/books/t0records.js";
import { config } from "../src/config.js";
import { T0_BUYERS } from "../src/desk/northwind.js";

const cfg = config();
if (!cfg.T0_IMPORT_API_KEY) throw new Error("T0_IMPORT_API_KEY is needed (a T:0 key issued with a Custom API connection)");
const t0 = new T0Mcp(cfg.T0_IMPORT_API_KEY);

const initech = T0_BUYERS.initech;
const buyers = [
  customerRecord(initech, "Initech", "ap@initech.example.com", "2026-08-15"),
  ...invoiceRecords({ id: "tab-inv-initech-3001", customerId: initech, amountCents: 6_000, issued: "2026-08-21", due: "2026-09-20", paidAt: "2026-09-25", memo: "INV-3001: data queries, paid 5 days late" }),
  ...invoiceRecords({ id: "tab-inv-initech-3002", customerId: initech, amountCents: 40_000, issued: "2026-09-18", due: "2026-10-18", memo: "INV-3002: data queries, unpaid" }),
  customerRecord(T0_BUYERS.globex, "Globex", "ap@globex.example.com", "2026-11-01"),
];
console.log("buyers:", JSON.stringify(await submitRecords(t0, buyers)));

if (process.argv.includes("--bill-payment")) {
  const rec = billPaymentRecord({ billExternalId: "t0_bill_prod_9a32a0da12fe3faf33e5", vendorExternalId: "t0_vendor_prod_78e1a442b0eb63a0b44c", amountCents: 10_000, date: "2026-11-10", transferId: "e75afb28-5ef0-4bd6-a088-8907e6ef17f8", shortRef: "P261110-20KVBW6" });
  console.log("bill payment:", JSON.stringify(await submitRecords(t0, [rec])));
}
