# Metal → Airwallex settlement (run 2026-11-08, Airwallex sandbox, US account)

The sandbox cannot receive stablecoins, so the off-ramp is a **simulated** deposit into the USD Global Account `7d7f991a-1360-4b31-9437-fa2167a9ab96`, referencing the Metal tx hash. Quote and conversion are real sandbox API calls.

| Metal pull (see metal-supplier-pull.md) | Deposit | Result |
| --- | --- | --- |
| `0x7beba4d4…1bbaff`, 1.80 USDZ | `26babe63-9c23-406c-a2a0-52f8984f055f` (1.80 USD, SETTLED) | 0.09 USD kept as 5% refund reserve; quote `6c5a0fc3-f68e-3d0b-a897-d00f75dd48fe` at 1.271566; conversion `fc0e2511-072d-4011-b1df-746e54b19d11` **SETTLED**: 1.71 USD → 2.17 SGD |
| `0x226c3733…43ee12`, 0.70 USDZ | `f65515ca-c085-4bbb-8bb9-16465ec65030` (0.70 USD, SETTLED) | quote refused `amount_below_limit` (Airwallex FX minimum): held in USD for a later sweep |

## What went wrong, and the fix
The first version of the bridge relied on Airwallex rejecting a repeated deposit with the same `statement_ref`. It does not: the sandbox accepted repeats and does not even store `statement_ref`. Re-running the script created three duplicate sandbox deposits for the same Metal transactions, which remain in the account history:

- `7570ae6a-b621-47fb-aea0-197db6f01dd6` (1.80 USD, repeat of `0x7beba…`, also converted again under quote `6db575f9-5f89-3321-89f9-37dd5f9e1dc3`)
- `51ce3d75-11d3-4d28-b186-bdae76b6bb97` and `dfd61726-8d17-4c02-bc61-c43f0e49ad88` (0.70 USD each, repeats of `0x226c…`)

Fix: TAB keeps its own settlement ledger keyed by Metal tx hash (`src/ledger/settlements.ts`), written before each step. A pending deposit is looked up in Airwallex by reference before any retry, and a pending conversion is retried with its saved `request_id`. Re-running both hashes after the fix returned `already_settled` for each, and the sandbox deposit count stayed at 5.
