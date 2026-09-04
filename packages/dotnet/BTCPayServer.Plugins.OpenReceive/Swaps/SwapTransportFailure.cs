#nullable enable
using System;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>Provider transport failures, classified without naming a provider.</summary>
public enum SwapTransportFailure
{
    /// <summary>The provider did not answer (network, timeout, 5xx, unparsable body).</summary>
    Unreachable,
    /// <summary>The provider answered, refusing this call (429 or its own weight budget).</summary>
    RateLimited,
    /// <summary>The provider answered with an application-level refusal.</summary>
    Refused,
}

public static class SwapTransportFailures
{
    /// <summary>Null when the failure is not a provider transport failure at all.</summary>
    public static SwapTransportFailure? Classify(Exception error)
    {
        if (error is SwapWeightBudgetException) return SwapTransportFailure.RateLimited;
        if (error is not FixedFloatApiException api) return null;
        if (api.Kind == FixedFloatApiErrorKind.RateLimited || api.Status == 429) return SwapTransportFailure.RateLimited;
        if (api.Kind is FixedFloatApiErrorKind.Timeout or FixedFloatApiErrorKind.Network or FixedFloatApiErrorKind.InvalidJson ||
            api.Status is >= 500)
        {
            return SwapTransportFailure.Unreachable;
        }
        return SwapTransportFailure.Refused;
    }
}
