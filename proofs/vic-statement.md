# Visa Intelligent Commerce via Airi: tab statement paid by card

Supplier checkout: Airwallex Payment Acceptance on the US sandbox account. Buyer side: `airi-cli` 0.1.0-beta.4 with the Airi test card (Visa …1111). Card data is written by Airi to a 0600 file, read once by the checkout code, and deleted; values are never printed.

## Run 2 (2026-11-09): paid
| Step | Result |
| --- | --- |
| Supplier statement `STM-20261109-E5DP` | 3 itemised lines, USD 186.00 (under the US$200 cap, not split), sha256 `0b5a592867e7e8ab…` stored in the payment intent's metadata |
| Airwallex payment intent | `int_sgpvtdh4nhnzlj965wb` |
| Buyer agent creates itemised Airi mandate (merchant Northwind Data) | `mdt_sgpdvzqsghnzlj9vq2w` |
| Human approves by passkey | approved |
| `airi-cli mandate get-credential --file` | single-use credential, `tokenType: DPAN` |
| Supplier checks: statement hash unchanged, total ≤ $200 | pass |
| Authorise only (`pre_auth`, no auto-capture) | `REQUIRES_CAPTURE`, attempt `AUTHORIZED`, amount 186 |
| Authorised amount = statement total → capture | `SUCCEEDED`, captured 186 |
| `airi-cli mandate result --result SUCCEEDED` | acknowledged `SUCCEEDED` |
| Independent re-read of the intent | `SUCCEEDED`, `captured_amount` 186, Visa …1111, `merchant_order_id` STM-20261109-E5DP |

## Run 1 (2026-11-08): blocked, then fixed
Statement `STM-20261108-WRRB`, intent `int_sgpvzc9hjhnz4sayxvl`, mandate `mdt_sgpdll5pnhnz4sb9wi8`. Airi issued the DPAN, but Airwallex refused the confirm: `This account is not enabled for native API access`. Reported to Airi as `DECLINED`; the intent remains unpaid. Airwallex enabled native API access on 2026-11-09, leading to run 2.

## Notes
- Airwallex confirmed the merchant sees a normal card transaction and cannot tell it was a VIC credential. The supplier links the payment to the passkey-approved mandate through its own records (mandate id + statement hash), not through the card.
- `airi-cli mandate list` shows both mandates as `COMPLETED` afterwards, including run 1 which was reported `DECLINED`; the list status appears to track the mandate lifecycle rather than the reported result.
