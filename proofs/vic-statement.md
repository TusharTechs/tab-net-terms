# Visa Intelligent Commerce via Airi: tab statement (run 2026-11-08)

Status: **Airi/VIC leg works; Airwallex capture blocked on account enablement** ("native API access", requested from Airwallex).

| Step | Result |
| --- | --- |
| Supplier statement `STM-20261108-WRRB` | 3 itemised lines, USD 186.00 (under the US$200 VIC cap, not split), sha256 `10f59c7c2a508cbf…` |
| Airwallex payment intent (supplier checkout, US sandbox account) | `int_sgpvzc9hjhnz4sayxvl`, amount read back 186 (major units), `REQUIRES_PAYMENT_METHOD` |
| Buyer agent creates Airi mandate (merchant Northwind Data, itemised, Airi test card Visa …1111) | `mdt_sgpdll5pnhnz4sb9wi8`, `CREATED` |
| Human approves the exact statement by passkey | approved |
| `airi-cli mandate get-credential --file` | single-use credential saved to a 0600 file; receipt `tokenType: DPAN`; file fields: number, expiry, cvv, cardHolderName, protocolType, tokenType, tokenExpiration (values never printed) |
| Supplier checks: statement hash unchanged, total ≤ $200 | pass |
| Confirm payment intent with the credential | **blocked**: `400 validation_error: This account is not enabled for native API access` |
| `airi-cli mandate result` | reported `DECLINED` with that reason; mandate status `DECLINED` |
| Credential file | deleted after the attempt |

Next: once native API access is enabled on, re-run `create` (a declined mandate cannot be reused) and `pay`.
