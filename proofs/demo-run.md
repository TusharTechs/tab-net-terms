# Full demo run (2026-11-10, run `dmwa9mdjr`)

`npx tsx scripts/demo-run.ts` plays six scenes into `data/desk-demo.json`; the demo screen (`npm run screen`) streams them. Live: Metal testnet, T:0 sandbox, the dispute model (`claude-opus-5-5`), Airwallex sandbox.

What is labelled rather than live:
- **Globex's books** are the stand-in (`fixtures/standin-books.json`). The T:0 sandbox has no customer with an open past-due invoice, and this T:0 key can read records and post journal entries but cannot create records (`403 CAPI72`).
- **The Airwallex deposit** is a sandbox simulation (the sandbox cannot receive stablecoins); quote and conversion are real sandbox calls.

| Scene | Result | Id |
| --- | --- | --- |
| 1. Onboarding | Acme's passkey-approved VIC payment (statement STM-20261109-E5DP, $186.00) recorded as its on-ramp to credit | payment intent `int_sgpvtdh4nhnzlj965wb` (see vic-statement.md) |
| 2. Terms | **T:0**: Acme is mapped to T:0 sandbox customer "Zephyr Metrics AB" (`t0_customer_prod_e9882b26f7979f04d28e`): 3 of 3 invoices paid on time → net-30. Acme's owner binds a $90 debit mandate → limit $90.00. Three agent orders ($6, $7, $5) go on the tab | bind `0xe2b224aaa31191f46f4bce6baf13bce3fe3bc287ca173b44f8779754db41c783` |
| 3. Books | Globex (`0xF6282AAD66B0dD563c714aad5E1D24019C1598C5`) binds a $30 mandate; stand-in books show INV-2002 22 days overdue and no VIC payment yet → **prepay**; its $40 order is routed to VIC prepay | bind `0x58ab291fe8eeffd6872634ca3edf4e0bc564f85dda31f2708fceea35d7fca866` |
| 4. Dispute | "Never agreed to 4 cents", "all 150 rows stale". Model extracts claims; code upholds the price claims with order proof and credits only the 15 QA-flagged rows: **$0.60** | read by `claude-opus-5-5` |
| 5. Hook | Acme's owner replaces the mandate with $25 → limit tightened → desk collects **$17.40** (= $18.00 − $0.60 credit) in one pull; re-read after the pull: $17.40 of $25.00 spent, limit $7.60 | replace `0xfe57e124331fb74dd62e08fc7850838141a42c7289ca53e812753a8b84eca37c`, collect `0x165bb661bd94c1d331b602cb2388d6aa278141f718f4d140ecbac5fcfb959554` |
| 6. Settle + book | Deposit $17.40 (reference = the Metal tx), keep $0.87 refund reserve, convert 16.53 USD → **21.00 SGD**; then **booked in T:0 as JE-2**: debit 11410 Payment Processor #1 (Airwallex cash), credit 12100 A/R - Customers (Zephyr Metrics AB), 1,740 atoms each, idempotency key = the Metal tx | deposit `2402df91-c477-492e-a8c6-1641d9e64a74`, conversion `69f3f382-981b-4288-85fe-98ecd7742960` **SETTLED**, T:0 journal entry `je_prod_DQKwtZPFxcNF5Zry` |

Re-checked after the run: all four Metal transactions returned receipt status `0x1`; the conversion read back SETTLED; the T:0 journal entry read back as JE-2, USD, 1,740 debit / 1,740 credit, credit line counterparty = the mapped customer. (The GL accounts above are the ones sent in the request; the read-back check did not compare account ids.)

T:0 notes: a repeat post with the same idempotency key returns `409 CAPI34 … it created je_… Nothing was written again`, which `bookCollection` treats as already booked. Before this run a 1-cent balanced connectivity test entry was posted (`je_prod_Qay4ZSSkkjWNSAiq`, JE-1, memo "TAB connectivity test").

Earlier runs on 2026-11-09 (`dmw9ibrgu`, `dmw9igrle`) used stand-in books for both buyers; their ids are in git history.
