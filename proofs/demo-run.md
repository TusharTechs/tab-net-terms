# Full demo run (2026-11-09, run `dmw9igrle`)

`npx tsx scripts/demo-run.ts` plays six scenes into `data/desk-demo.json`; the demo screen (`npm run screen`) streams them. Live: Metal testnet, the dispute model (`claude-opus-5-5`), Airwallex sandbox. Labelled: books are the stand-in (`fixtures/standin-books.json`) until T:0 access works; the Airwallex deposit is a sandbox simulation (it cannot receive stablecoins).

| Scene | Result | Id |
| --- | --- | --- |
| 1. Onboarding | Acme's passkey-approved VIC payment (statement STM-20261109-E5DP, $186.00) recorded as its on-ramp to credit | payment intent `int_sgpvtdh4nhnzlj965wb` (see vic-statement.md) |
| 2. Terms | Acme's owner binds a $90 debit mandate. Limit $78.30: capped by Acme's on-chain balance after an earlier run. Three agent orders ($6.00, $7.00, $5.00) go on the tab, net-30 | bind `0xdc2d72fe3afdd4ce4e405960b745cac03811c1597a4b395bd26195a7a4a72e45` |
| 3. Books | Globex (`0xF6282AAD66B0dD563c714aad5E1D24019C1598C5`) binds a $30 mandate; stand-in books show INV-2002 22 days overdue and no VIC payment yet → **prepay**; its $40 order is routed to VIC prepay | bind `0x0b68dc33ca6980ee9f69b78c3da7fe59710b1f6eecf2ffa291cd1f8a2701195e` |
| 4. Dispute | Email: "never agreed to 4 cents", "all 150 rows stale". Model extracts claims; code upholds the price claims with order proof and credits only the 15 QA-flagged rows: **$0.60** | read by `claude-opus-5-5` |
| 5. Hook | Acme's owner replaces the mandate with $25 → limit tightened → desk collects **$17.40** (= $18.00 − $0.60 credit) for the three orders in one pull; re-read after the pull: $17.40 of $25.00 spent, limit $7.60 | replace `0x071bf088d032ea1c70dcf07c2e120f3f287aedc8d5e2299fa68124e7c8f17989`, collect `0x5652f02f107b614e26d34ce2e9b81dbfc5aab020d159eb51514f6bc81a31ac0f` |
| 6. Settle | Deposit $17.40 (simulated off-ramp, reference = the Metal tx), keep $0.87 refund reserve, quote and convert 16.53 USD → **21.03 SGD** | deposit `62adfc21-f62d-4c3b-9e77-4c702eeade16` (status PENDING when re-read), quote `76c1a655-671c-388d-b0a6-2c66b34a7afc`, conversion `95313a81-800f-4546-93a6-901ac643faa9` **SETTLED** |

All four Metal transactions above returned receipt status `0x1` when re-checked. An earlier run the same day (`dmw9ibrgu`) produced the same outcomes with conversion `e4f256ea-0f45-43bd-85dd-b5cbf7b9dc4b` (SETTLED); its log showed duplicate decision lines and a pre-pull snapshot on the buyer card, both fixed before this run.
