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
  /** T:0 MCP endpoint issued with your key. */
  T0_MCP_URL: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** "bedrock" (default; AWS credential chain) or "anthropic" (ANTHROPIC_API_KEY). */
  CLAUDE_PROVIDER: z.enum(["bedrock", "anthropic"]).default("bedrock"),
  BEDROCK_REGION: z.string().default("us-west-2"),
  /** Defaults per provider: anthropic.claude-opus-5-5 on Bedrock, claude-opus-5-5 on the Claude API. */
  CLAUDE_MODEL: z.string().optional(),
  /** Bedrock only: client-side refusal fallback model (no server-side `fallbacks` there). Empty disables it. */
  CLAUDE_FALLBACK_MODEL: z.string().default("anthropic.claude-opus-4-8"),
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
