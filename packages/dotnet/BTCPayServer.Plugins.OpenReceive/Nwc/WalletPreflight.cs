#nullable enable
using System.Linq;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// The verdict of a wallet preflight: Ok, or a code (missing_required_method,
/// unsupported_encryption, spend_capability_advertised) with a host-facing message.
/// <see cref="Warning"/> is set when the connection is usable only because the operator
/// overrode the spend-capability refusal.
/// </summary>
public sealed record WalletPreflightResult(bool Ok, string? Code, string? Message, WalletCapabilitySummary Summary)
{
    public string? Warning { get; init; }
}

/// <summary>
/// Decides whether a summarized connection may be used for receive checkout — the C# twin of
/// the preflight rules in <c>packages/js/node/src/nwc/client.ts</c>. Missing receive methods
/// are checked first, then encryption, then the spend-capability refusal (or its override).
/// </summary>
public static class WalletPreflight
{
    public static WalletPreflightResult Evaluate(WalletCapabilitySummary summary, bool allowSpendCapableWallet)
    {
        if (summary.MissingMethods.Count > 0)
        {
            var message = string.Join("\n",
                $"This NWC connection does not grant the receive methods OpenReceive needs: missing {string.Join(", ", summary.MissingMethods)}. Required: {string.Join(", ", OpenReceiveTables.NwcRequiredReceiveMethods)}.",
                $"Get a receive-only NWC code here: {NwcUri.CodeHelpUrl}");
            return new WalletPreflightResult(false, "missing_required_method", message, summary);
        }

        if (summary.Encryption is null)
        {
            return new WalletPreflightResult(false, "unsupported_encryption",
                "This NWC wallet advertises encryption modes OpenReceive does not speak (nip44_v2 or nip04 are required).",
                summary);
        }

        if (summary.SpendCapabilityAdvertised)
        {
            var spendMethods = summary.SpendMethods.ToArray();
            if (!allowSpendCapableWallet)
            {
                return new WalletPreflightResult(false, "spend_capability_advertised",
                    NwcUri.FormatSpendCapabilityRefusedMessage(spendMethods), summary);
            }
            return new WalletPreflightResult(true, null, null, summary)
            {
                Warning = NwcUri.FormatSpendCapabilityWarningMessage(spendMethods),
            };
        }

        return new WalletPreflightResult(true, null, null, summary);
    }
}
