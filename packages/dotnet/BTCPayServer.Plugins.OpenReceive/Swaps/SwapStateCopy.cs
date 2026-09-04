#nullable enable
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>One swap provider state with its payer-facing copy, coarse phase, and terminality.</summary>
public sealed record SwapStateInfo(string State, string Label, string Detail, string Phase, bool Terminal);

/// <summary>
/// The canonical catalog of every swap provider_state: the state → phase/terminal table
/// is kernel vocabulary (OpenReceiveTables.SwapStates); this adds the payer-facing copy.
/// <c>completed</c> is deliberately NON-terminal and lives in the <c>settling</c> phase:
/// provider completion is not payment.
/// </summary>
public static class SwapStateCopy
{
    private static readonly IReadOnlyDictionary<string, (string Label, string Detail)> Copy =
        new Dictionary<string, (string, string)>
        {
            ["creating_provider_order"] = ("Preparing payment address", "Creating a payment address."),
            ["awaiting_deposit"] = ("Waiting for your payment", "Send exactly the amount shown below."),
            ["confirming"] = ("Confirming payment", "Your payment was detected and is confirming on-chain."),
            ["exchanging"] = ("Converting payment", "Your payment is confirmed and being converted. This usually finishes within a minute."),
            ["paying_invoice"] = ("Finalizing checkout", "The provider is sending the Lightning payment. This usually takes a few seconds."),
            ["completed"] = ("Finalizing checkout", "The provider is sending the Lightning payment. This usually takes a few seconds."),
            ["expired"] = ("Expired", "No payment was received before the payment window closed."),
            ["refund_required"] = ("Refund needed", "Enter an address you control to request a refund."),
            ["refund_pending"] = ("Refund pending", "Your refund request has been sent."),
            ["refunded"] = ("Refunded", "The provider reports the refund was sent."),
            ["attention"] = ("Needs attention", "This payment needs support review."),
            ["failed"] = ("Failed", "This payment address can no longer be used."),
        };

    public static IReadOnlyDictionary<string, SwapStateInfo> States { get; } = Build();

    public static SwapStateInfo For(string state) =>
        States.TryGetValue(state, out var info)
            ? info
            : throw new ArgumentException($"Unknown swap provider state {state}.", nameof(state));

    private static ReadOnlyDictionary<string, SwapStateInfo> Build()
    {
        var states = new Dictionary<string, SwapStateInfo>(StringComparer.Ordinal);
        foreach (var state in OpenReceiveTables.SwapProviderStates)
        {
            if (!Copy.TryGetValue(state, out var copy))
            {
                throw new InvalidOperationException($"Swap provider state {state} has no payer-facing copy.");
            }
            var table = OpenReceiveTables.SwapStates[state];
            states[state] = new SwapStateInfo(state, copy.Label, copy.Detail, table.Phase, table.Terminal);
        }
        return new ReadOnlyDictionary<string, SwapStateInfo>(states);
    }
}
