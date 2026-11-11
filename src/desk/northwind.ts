/**
 * Northwind Data's testnet/sandbox identities for the demo. Addresses and ids only; the key
 * files they name live in keys/ (git-ignored) and are never printed.
 */
export const NORTHWIND = {
  /** Supplier wallet: payee of every mandate, and the key that records refusals on chain. */
  supplier: "0x6C7578104c945e6A0b21eD9f022abE197a40B6B4",
  supplierWalletKey: "keys/supplier-wallet.json",
  issuer: { key: "keys/supplier-issuer.json", pub: "keys/supplier-issuer.public.json" },
  /** The CFO's policy-signing key: separate from the Metal issuer key. */
  cfoPolicyKey: { key: "keys/cfo-policy.json", pub: "keys/cfo-policy.public.json" },
  usdGlobalAccount: "7d7f991a-1360-4b31-9437-fa2167a9ab96",
} as const;

export const BUYERS = {
  acme: { account: "0x4d0a5161AbA00FB71397675a1919163d6e7cEd33", owner: "keys/buyer-owner.json", t0Customer: "t0_customer_prod_e9882b26f7979f04d28e" },
  globex: { owner: "keys/globex-owner.json" },
} as const;

/**
 * Our ids for the buyers written into T:0 by scripts/t0-seed-buyers.ts. T:0 gives each its own id
 * after its nightly run; these stay findable as the record's platform_object_id.
 */
export const T0_BUYERS = { initech: "tab-cust-initech", globex: "tab-cust-globex" } as const;

/** The Airi test card (payment method id) enrolled for the demo. */
export const AIRI_TEST_CARD = "6a54bf19-f0f0-49ae-b2ef-c593de41577a";
