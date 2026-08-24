/**
 * Provider transport failures, classified without naming a provider.
 *
 * A FixedFloat outage, timeout, or 429 during a swap create/status/refund is a
 * provider problem, not an OpenReceive bug: the service maps these to the
 * 502/503 the OpenAPI spec declares for those routes. Without a classification
 * they are neither a ServiceError nor a wallet error, and errorResponse turns
 * every provider hiccup into a generic 500 INTERNAL.
 */
import { isSwapProviderWeightBudgetError } from "./weight-budget.ts";

export type SwapTransportFailure =
  /** The provider did not answer (network, timeout, 5xx, unparsable body). */
  | "unreachable"
  /** The provider answered, refusing this call (429 or its own weight budget). */
  | "rate_limited"
  /** The provider answered with an application-level refusal. */
  | "refused";

interface ProviderApiErrorShape {
  readonly kind: string;
  readonly status?: number;
}

function isProviderApiError(error: unknown): error is ProviderApiErrorShape {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; kind?: unknown };
  return typeof candidate.kind === "string" && candidate.name === "FixedFloatApiError";
}

/** undefined when the failure is not a provider transport failure at all. */
export function classifySwapTransportFailure(error: unknown): SwapTransportFailure | undefined {
  if (isSwapProviderWeightBudgetError(error)) return "rate_limited";
  if (!isProviderApiError(error)) return undefined;
  if (error.kind === "rate_limited" || error.status === 429) return "rate_limited";
  if (
    error.kind === "timeout" ||
    error.kind === "network" ||
    error.kind === "invalid_json" ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "unreachable";
  }
  return "refused";
}
