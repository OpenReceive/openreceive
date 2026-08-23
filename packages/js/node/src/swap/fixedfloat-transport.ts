/**
 * Everything that crosses the wire to a FixedFloat-compatible API: the
 * HMAC-signed `/api/v2` POST, envelope parsing into data or FixedFloatApiError,
 * request/response log surfacing, and weight-budget reserve / 429 accounting.
 * The unauthenticated XML rates GET lives in fixedfloat-rates.ts.
 */

import { createHmac } from "node:crypto";
import { optionalCoercedString } from "./fixedfloat-fields.ts";
import type { SwapProviderApiRequestLog, SwapProviderApiResponseLog } from "./provider.ts";

/** The process-local request weight guard the service attaches (see weight-budget.ts). */
export interface FixedFloatWeightBudget {
  reserve(path: string): Promise<void>;
  markRateLimited(): Promise<void>;
  canReserve(path: string): Promise<boolean>;
}

interface FixedFloatEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

export class FixedFloatApiError extends Error {
  readonly path: string;
  readonly kind: "api" | "http" | "invalid_json" | "network" | "rate_limited" | "timeout";
  readonly status?: number;
  readonly fixedFloatCode?: unknown;
  readonly fixedFloatMessage?: string;

  constructor(input: {
    readonly path: string;
    readonly kind: FixedFloatApiError["kind"];
    readonly status?: number;
    readonly fixedFloatCode?: unknown;
    readonly fixedFloatMessage?: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "FixedFloatApiError";
    this.path = input.path;
    this.kind = input.kind;
    this.status = input.status;
    this.fixedFloatCode = input.fixedFloatCode;
    this.fixedFloatMessage = input.fixedFloatMessage;
  }

  static fromFetchError(path: string, error: unknown): FixedFloatApiError {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
    return new FixedFloatApiError({
      path,
      kind: aborted ? "timeout" : "network",
      message: aborted
        ? `FixedFloat ${path} request timed out.`
        : `FixedFloat ${path} request failed before a response was received.`,
      cause: error,
    });
  }
}

export class FixedFloatTransport {
  /** Already stripped of trailing slashes; also the origin of the XML rates GET. */
  readonly baseUrl: string;
  readonly fetcher: typeof globalThis.fetch;
  readonly requestTimeoutMs: number;
  private readonly provider: string;
  private readonly key: string;
  private readonly secret: string;
  private apiRequestLogger: ((entry: SwapProviderApiRequestLog) => void) | undefined;
  private apiResponseLogger: ((entry: SwapProviderApiResponseLog) => void) | undefined;
  private weightBudget: FixedFloatWeightBudget | undefined;

  constructor(input: {
    /** Provider name stamped on every log entry. */
    readonly provider: string;
    readonly key: string;
    readonly secret: string;
    readonly baseUrl: string;
    readonly fetch: typeof globalThis.fetch;
    readonly requestTimeoutMs: number;
  }) {
    this.provider = input.provider;
    this.key = input.key;
    this.secret = input.secret;
    this.baseUrl = input.baseUrl;
    this.fetcher = input.fetch;
    this.requestTimeoutMs = input.requestTimeoutMs;
  }

  attachApiRequestLogger(log: (entry: SwapProviderApiRequestLog) => void): void {
    this.apiRequestLogger = log;
  }

  attachApiResponseLogger(log: (entry: SwapProviderApiResponseLog) => void): void {
    this.apiResponseLogger = log;
  }

  attachWeightBudget(budget: FixedFloatWeightBudget): void {
    this.weightBudget = budget;
  }

  async canAcceptRequest(path: string): Promise<boolean> {
    if (this.weightBudget === undefined) return true;
    return await this.weightBudget.canReserve(path);
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.weightBudget !== undefined) {
      await this.weightBudget.reserve(path);
    }
    const bodyString = JSON.stringify(body);
    // Surface every outbound request before the call. The service sink sanitizes
    // nested secrets (e.g. the order token on status/refund bodies); the API key
    // and HMAC signature live in headers and are deliberately never logged.
    this.logApiRequest(path, body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/v2/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-API-KEY": this.key,
          "X-API-SIGN": createHmac("sha256", this.secret).update(bodyString).digest("hex"),
        },
        body: bodyString,
        signal: controller.signal,
      });
    } catch (error) {
      const apiError = FixedFloatApiError.fromFetchError(path, error);
      this.logApiResponse({
        path,
        status: 0,
        ok: false,
        msg: apiError.message,
      });
      throw apiError;
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed: FixedFloatEnvelope;
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as FixedFloatEnvelope);
    } catch (error) {
      this.logApiResponse({
        path,
        status: response.status,
        ok: false,
        msg: `FixedFloat ${path} returned invalid JSON.`,
      });
      throw new FixedFloatApiError({
        path,
        kind: "invalid_json",
        status: response.status,
        message: `FixedFloat ${path} returned invalid JSON.`,
        cause: error,
      });
    }
    // Surface every response (including API-error envelopes) before any throw. The
    // service sink sanitizes nested secrets — notably the order token in a
    // create/order response — so this must not pre-redact.
    this.logApiResponse({
      path,
      status: response.status,
      ok: response.ok,
      code: parsed.code,
      msg: parsed.msg,
      data: parsed.data,
    });
    if (!response.ok) {
      if (response.status === 429 && this.weightBudget !== undefined) {
        await this.weightBudget.markRateLimited();
      }
      throw new FixedFloatApiError({
        path,
        kind: response.status === 429 ? "rate_limited" : "http",
        status: response.status,
        fixedFloatMessage: optionalCoercedString(parsed.msg),
        message: formatFixedFloatApiErrorMessage(path, response.status, parsed.msg),
      });
    }
    if (parsed.code !== 0) {
      throw new FixedFloatApiError({
        path,
        kind: "api",
        fixedFloatCode: parsed.code,
        fixedFloatMessage: optionalCoercedString(parsed.msg),
        message: typeof parsed.msg === "string" ? parsed.msg : `FixedFloat ${path} failed.`,
      });
    }
    return parsed.data;
  }

  logApiRequest(path: string, body: Record<string, unknown> = {}): void {
    this.apiRequestLogger?.({
      provider: this.provider,
      path,
      body,
    });
  }

  logApiResponse(input: {
    readonly path: string;
    readonly status: number;
    readonly ok: boolean;
    readonly code?: unknown;
    readonly msg?: unknown;
    readonly data?: unknown;
  }): void {
    this.apiResponseLogger?.({
      provider: this.provider,
      path: input.path,
      status: input.status,
      ok: input.ok,
      code: input.code,
      msg: input.msg,
      data: input.data,
    });
  }
}

function formatFixedFloatApiErrorMessage(path: string, status: number, msg: unknown): string {
  const fixedFloatMessage = optionalCoercedString(msg);
  return fixedFloatMessage === undefined
    ? `FixedFloat ${path} failed with HTTP ${status}.`
    : `FixedFloat ${path} failed with HTTP ${status}: ${fixedFloatMessage}`;
}
