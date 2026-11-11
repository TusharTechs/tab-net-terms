/**
 * Writes the demo's books into the T:0 sandbox, replacing the local stand-in:
 * - Initech's history (one invoice paid 5 days late, one $400 invoice overdue since Oct 18).
 * - Globex as a customer with no invoices, plus the $80 it really paid in run rmwavgb3a (Metal
 *   collection, settled into Airwallex) as a payment applied to no invoice. The credit check reads
 *   invoices only, so Globex is still a buyer with no history; the payment books money that was never
 *   booked and makes Globex readable in T:0, so later runs can name it on a journal entry.
 * - Three open $150 Slack bills a week apart, for the vendor payout to find, owed to our own Slack
 *   vendor record (links to the Ramp-sourced Slack vendor did not resolve). Its T:0 id is mapped to the
 *   Slack sandbox beneficiary in data/payout/beneficiaries.json. A run proves about SGD 350, so it
 *   pays the oldest and holds the next.
 * Optionally records the bill payment for the bill paid in the payout test. Fixed ids, so a re-run
 * replaces rather than duplicates.
 *   npx tsx scripts/t0-seed-buyers.ts [--bill-payment]
 * T:0 reads these back through its API after its next nightly run (see src/books/t0records.ts).
 */
import { T0Mcp } from "../src/books/books.js";
import { billPaymentRecord, customerPaymentRecord, customerRecord, invoiceRecords, submitRecords, vendorBillRecord, vendorRecord } from "../src/books/t0records.js";
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
  customerPaymentRecord({
    id: "tab-pmt-globex-rmwavgb3a",
    customerId: T0_BUYERS.globex,
    amountCents: 8_000,
    date: "2026-11-10",
    description: "TAB net-7 tab collected via Metal debit mandate and settled into Airwallex (run rmwavgb3a)",
    customFields: { metal_tx: "0xd073c3b4ec005cc9ba3c96dbacd6abeca1bb1014a250de26d6ce49b1bd3e3d21", airwallex_deposit_id: "a32ea8ce-2906-4c2e-b2d6-48b5cb9e5c88", airwallex_conversion_id: "de215efb-ee9e-486e-b557-b030c382d46f" },
  }),
];
console.log("buyers:", JSON.stringify(await submitRecords(t0, buyers)));

const SLACK = "tab-vendor-slack";
const bills = [
  vendorRecord(SLACK, "Slack Technologies, Inc.", "2026-10-01"),
  ...[["2026-10-20", "2026-11-04"], ["2026-10-27", "2026-11-11"], ["2026-11-03", "2026-11-18"]].map(([date, due]) =>
  vendorBillRecord({ id: `tab-bill-slack-${date!.replaceAll("-", "")}`, vendorId: SLACK, number: `SLK-${date!.replaceAll("-", "")}`, amountCents: 15_000, date: date!, due: due!, memo: "Slack seats, monthly (demo bill written by TAB)" }),
  ),
];
console.log("vendor bills:", JSON.stringify(await submitRecords(t0, bills)));

if (process.argv.includes("--bill-payment")) {
  const rec = billPaymentRecord({ billExternalId: "t0_bill_prod_9a32a0da12fe3faf33e5", vendorExternalId: "t0_vendor_prod_78e1a442b0eb63a0b44c", amountCents: 10_000, date: "2026-11-10", transferId: "e75afb28-5ef0-4bd6-a088-8907e6ef17f8", shortRef: "P261110-20KVBW6" });
  console.log("bill payment:", JSON.stringify(await submitRecords(t0, [rec])));
}
