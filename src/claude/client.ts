import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * Claude for TAB's model-facing steps (reading dispute emails, drafting notices).
 *
 * - bedrock (default): Amazon Bedrock Mantle with the default AWS credential chain.
 *   Bedrock has no server-side `fallbacks`, so refusals are retried on a fallback
 *   model by the SDK's client-side middleware.
 * - anthropic: the Claude API with ANTHROPIC_API_KEY and server-side `fallbacks: "default"`.
 */
export interface ClaudeTarget {
  client: AnthropicBedrockMantle | Anthropic;
  model: string;
  /** Extra request fields for this provider (server-side fallbacks on the Claude API). */
  requestExtras: Record<string, unknown>;
  provider: "bedrock" | "anthropic";
}

export function claude(): ClaudeTarget {
  const cfg = config();
  if (cfg.CLAUDE_PROVIDER === "anthropic") {
    return {
      provider: "anthropic",
      client: new Anthropic(),
      model: cfg.CLAUDE_MODEL ?? "claude-opus-5-5",
      requestExtras: { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
    };
  }
  return {
    provider: "bedrock",
    client: new AnthropicBedrockMantle({
      awsRegion: cfg.BEDROCK_REGION,
      ...(cfg.CLAUDE_FALLBACK_MODEL ? { middleware: [betaRefusalFallbackMiddleware([{ model: cfg.CLAUDE_FALLBACK_MODEL }])] } : {}),
    }),
    model: cfg.CLAUDE_MODEL ?? "anthropic.claude-opus-5-5",
    requestExtras: {},
  };
}
