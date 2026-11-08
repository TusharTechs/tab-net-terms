import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  AWX_BASE_URL: z.string().url().default("https://api.sandbox.airwallex.com"),
  AWX_FILES_URL: z.string().url().default("https://files.sandbox.airwallex.com"),
  AWX_ACCOUNT_ID: z.string().startsWith("acct_"),
  AWX_CLIENT_ID: z.string().min(1),
  AWX_API_KEY: z.string().min(1),
  AWX_WEBHOOK_SECRET: z.string().optional(),

  METAL_NETWORK: z.string().default("testnet"),
  METAL_CHAIN_ID: z.coerce.number().default(63825),
  METAL_RPC_URL: z.string().optional(),
  METAL_SUPPLIER_ISSUER_KEY_FILE: z.string().default("./keys/supplier-issuer.key"),
  METAL_SUPPLIER_MANDATE_KEY_FILE: z.string().default("./keys/supplier-mandate.key"),
  METAL_BUYER_OWNER_KEY_FILE: z.string().default("./keys/buyer-owner.key"),

  T0_USERNAME: z.string().optional(),
  T0_API_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;

/** Loads and validates .env once. Throws with the names (never values) of bad fields. */
export function config(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing .env values: ${fields}`);
  }
  cached = parsed.data;
  return cached;
}
