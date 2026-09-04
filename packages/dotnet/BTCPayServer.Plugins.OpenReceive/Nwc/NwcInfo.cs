#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// Reads a wallet's NIP-47 <c>get_info</c> reply and/or its kind-13194 info event into a
/// <see cref="WalletCapabilitySummary"/> — the C# twin of <c>summarizeWalletCapabilities</c>,
/// <c>chooseEncryptionMode</c> and <c>normalizeNwcMethodName</c> in
/// <c>packages/js/node/src/nwc/normalize.ts</c>.
/// </summary>
public static class NwcInfo
{
    private static readonly Regex CamelBoundary = new("([a-z0-9])([A-Z])", RegexOptions.Compiled);
    private static readonly Regex DashOrSpace = new("[-\\s]+", RegexOptions.Compiled);
    private static readonly Regex ListSeparator = new("[,\\s]+", RegexOptions.Compiled);

    /// <summary>
    /// <paramref name="rawInfo"/> is the method list that governs this connection (<c>get_info</c>,
    /// or the info event when that is all the client has). <paramref name="rawServiceInfo"/>, when
    /// given, is the info event: encryption is negotiated service-wide, so its modes win.
    /// </summary>
    public static WalletCapabilitySummary Summarize(NwcUri connection, JsonNode? rawInfo, JsonNode? rawServiceInfo = null)
    {
        var unwrappedInfo = NwcNormalize.Unwrap(rawInfo);
        var info = NwcNormalize.Record(unwrappedInfo);
        var serviceInfo = rawServiceInfo is null ? null : NwcNormalize.Record(NwcNormalize.Unwrap(rawServiceInfo));

        var methodSource = First(info, "methods", "capabilities", "supported_methods", "supportedMethods")
            ?? (unwrappedInfo is JsonValue bare && bare.TryGetValue<string>(out _) ? unwrappedInfo : null);
        var methods = StringList(methodSource).Select(NormalizeMethodName).ToArray();

        var encryptionSource = First(serviceInfo, "encryption", "encryptions") ?? First(info, "encryption", "encryptions");
        var encryption = ChooseEncryptionMode(StringList(encryptionSource));

        var spendMethods = SpendMethodsIn(methods);
        var missingMethods = OpenReceiveTables.NwcRequiredReceiveMethods.Where(m => !methods.Contains(m)).ToArray();
        var warnings = spendMethods
            .Select(m => $"Wallet advertises spend method '{m}'; OpenReceive checkout will not expose it.")
            .ToArray();

        var notifications = StringList(First(serviceInfo, "notifications") ?? First(info, "notifications"));
        var network = (First(info, "network") ?? First(serviceInfo, "network")) is JsonValue networkValue
            && networkValue.TryGetValue<string>(out var networkText)
            && networkText.Trim().Length > 0
            ? networkText.Trim()
            : null;

        return new WalletCapabilitySummary
        {
            WalletPubkey = connection.WalletPubkey,
            Relays = connection.RelayUrls.ToArray(),
            Methods = methods,
            Encryption = encryption,
            SpendCapabilityAdvertised = spendMethods.Count > 0,
            ReceiveCheckoutReady = missingMethods.Length == 0,
            Warnings = warnings,
            SpendMethods = spendMethods,
            MissingMethods = missingMethods,
            Notifications = notifications,
            Network = network,
        };
    }

    /// <summary>Summarize from the info event alone (no <c>get_info</c> round-trip yet).</summary>
    public static WalletCapabilitySummary FromServiceInfo(NwcUri connection, NwcServiceInfo serviceInfo)
    {
        var raw = new JsonObject
        {
            ["methods"] = new JsonArray(serviceInfo.Methods.Select(m => (JsonNode?)JsonValue.Create(m)).ToArray()),
            ["notifications"] = new JsonArray(serviceInfo.Notifications.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()),
            ["encryption"] = new JsonArray(serviceInfo.EncryptionSchemes.Select(e => (JsonNode?)JsonValue.Create(e)).ToArray()),
        };
        return Summarize(connection, raw);
    }

    /// <summary>
    /// The mode OpenReceive will speak, in <see cref="OpenReceiveTables.NwcEncryptionModes"/>
    /// preference order. No advertised list at all means the NIP-47 baseline (NIP-04); an
    /// advertised list with nothing we speak is null so preflight can fail loudly.
    /// </summary>
    public static string? ChooseEncryptionMode(IEnumerable<string> encryptionModes)
    {
        var normalized = encryptionModes
            .Select(mode => mode.ToLowerInvariant().Replace('-', '_').Replace(' ', '_'))
            .Select(mode => mode switch
            {
                "nip44" or "nip_44" => "nip44_v2",
                "nip_04" => "nip04",
                _ => mode,
            })
            .ToArray();
        if (normalized.Length == 0) return Nip47Baseline;
        return OpenReceiveTables.NwcEncryptionModes.FirstOrDefault(normalized.Contains);
    }

    private const string Nip47Baseline = "nip04";

    /// <summary>getInfo → get_info, list-transactions → list_transactions, trimmed and lowercased.</summary>
    public static string NormalizeMethodName(string value)
    {
        var text = CamelBoundary.Replace(value.Trim(), "$1_$2");
        return DashOrSpace.Replace(text, "_").ToLowerInvariant();
    }

    /// <summary>The advertised methods that are spend methods, in the wallet's order.</summary>
    public static IReadOnlyList<string> SpendMethodsIn(IEnumerable<string> methods) =>
        methods.Where(m => OpenReceiveTables.NwcSpendMethods.Contains(m)).ToArray();

    /// <summary>An array of strings (non-strings dropped) or a comma/whitespace-separated string.</summary>
    private static IReadOnlyList<string> StringList(JsonNode? value)
    {
        if (value is JsonArray array)
        {
            return array
                .Select(item => item is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : "")
                .Where(s => s.Length > 0)
                .ToArray();
        }
        if (value is JsonValue single && single.TryGetValue<string>(out var text))
        {
            return ListSeparator.Split(text).Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
        }
        return Array.Empty<string>();
    }

    private static JsonNode? First(JsonObject? record, params string[] keys)
    {
        if (record is null) return null;
        foreach (var key in keys)
        {
            if (record[key] is { } value) return value;
        }
        return null;
    }
}
