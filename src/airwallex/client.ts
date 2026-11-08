import { randomUUID } from "node:crypto";

/** Error returned by an Airwallex API call. `code` is Airwallex's own error code. */
export class AirwallexError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly traceId: string | undefined,
    readonly path: string,
  ) {
    super(`Airwallex ${status} ${code ?? ""} on ${path}: ${message}${traceId ? ` (trace ${traceId})` : ""}`);
    this.name = "AirwallexError";
  }

  /** The three insufficient-funds codes Airwallex returns for the same state, by endpoint. */
  get isInsufficientFunds(): boolean {
    return ["balance_insufficient", "insufficient_fund", "insufficient_funds"].includes(this.code ?? "");
  }
}

export interface AirwallexClientOptions {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Sends x-on-behalf-of for connected-account calls. */
  onBehalfOf?: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/**
 * Thin, typed wrapper over the Airwallex REST API.
 * - Caches the 30-minute bearer token and refreshes it a minute early, or once on a 401.
 * - Retries 429 and 5xx with backoff. Retrying a mutating call is safe only because every
 *   mutating call carries a request_id the caller generated once (see newRequestId).
 * - Never retries other 4xx: those are decisions, not glitches.
 */
export class AirwallexClient {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AirwallexClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async authenticate(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.opts.clientId, "x-api-key": this.opts.apiKey },
    });
    const json = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; code?: string; message?: string };
    if (!res.ok || !json.token) {
      throw new AirwallexError(res.status, json.code, json.message ?? "login failed", res.headers.get("x-b3-traceid") ?? undefined, "/authentication/login");
    }
    const expiresAt = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 30 * 60_000;
    this.token = { value: json.token, expiresAt };
    return json.token;
  }

  async request<T>(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.opts.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.authenticate();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.onBehalfOf) headers["x-on-behalf-of"] = options.onBehalfOf;

      const res = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const traceId = res.headers.get("x-b3-traceid") ?? undefined;
      const text = await res.text();
      const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

      if (res.ok) return json as T;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.authenticate(true);
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
        await this.sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      throw new AirwallexError(res.status, json.code as string | undefined, (json.message as string) ?? text, traceId, path);
    }
  }

  get<T>(path: string, options?: Omit<RequestOptions, "body">) {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body: unknown, options?: Omit<RequestOptions, "body">) {
    return this.request<T>("POST", path, { ...options, body });
  }
}

/**
 * A request_id for ONE logical operation. Generate it when the operation is decided,
 * persist it with the decision, and reuse it only to retry that same operation.
 * 36 chars satisfies the transfers endpoint's 10–50 char rule.
 */
export function newRequestId(): string {
  return randomUUID();
}
