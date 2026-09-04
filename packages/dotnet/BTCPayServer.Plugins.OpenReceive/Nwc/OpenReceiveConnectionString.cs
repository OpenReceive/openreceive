#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// The one BTCPay Lightning connection string this plugin answers to:
/// <c>type=openreceive;nwc=&lt;NWC URI&gt;[;allow-spend=true]</c>. The prefix is what
/// keeps this plugin and the Nostr plugin deterministic when both are installed: a
/// bare <c>nostr+walletconnect://</c> string or <c>type=nwc;key=…</c> is never ours.
/// The connection string is the authoritative home of the spend override; settings
/// only mirror it for the UI.
/// </summary>
public sealed record OpenReceiveConnectionString(string NwcUri, bool AllowSpendCapableWallet)
{
    public const string TypePrefix = "type=openreceive";
    public const string NwcKey = "nwc";
    public const string AllowSpendKey = "allow-spend";

    /// <summary>The canonical text BTCPay persists (<c>ILightningClient.ToString()</c>).</summary>
    public string Format() =>
        AllowSpendCapableWallet
            ? $"{TypePrefix};{NwcKey}={NwcUri};{AllowSpendKey}=true"
            : $"{TypePrefix};{NwcKey}={NwcUri}";

    public static string Format(string nwcUri, bool allowSpendCapableWallet) =>
        new OpenReceiveConnectionString(nwcUri, allowSpendCapableWallet).Format();

    /// <summary>True when the string carries our prefix, whatever else it contains.</summary>
    public static bool IsOurs(string? connectionString) =>
        connectionString is not null &&
        connectionString.TrimStart().StartsWith(TypePrefix, StringComparison.OrdinalIgnoreCase) &&
        (connectionString.TrimStart().Length == TypePrefix.Length || connectionString.TrimStart()[TypePrefix.Length] == ';');

    /// <summary>
    /// Parses our prefix. Returns null when the string is not ours at all (another
    /// handler may claim it); throws <see cref="FormatException"/> when it is ours but
    /// malformed. Values are split on <c>;</c> and the first <c>=</c> only, so the NWC
    /// URI's own <c>?relay=…&amp;secret=…</c> survives intact.
    /// </summary>
    public static OpenReceiveConnectionString? Parse(string connectionString)
    {
        if (!IsOurs(connectionString)) return null;
        var items = connectionString.Trim().Split(';', StringSplitOptions.RemoveEmptyEntries);
        string? nwc = null;
        var allowSpend = false;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items.Skip(1))
        {
            var separator = item.IndexOf('=');
            var key = (separator < 0 ? item : item[..separator]).Trim();
            var value = separator < 0 ? string.Empty : item[(separator + 1)..].Trim();
            if (!seen.Add(key))
            {
                throw new FormatException($"OpenReceive connection string repeats '{key}'.");
            }
            switch (key.ToLowerInvariant())
            {
                case NwcKey:
                    nwc = value;
                    break;
                case AllowSpendKey:
                    allowSpend = value.Equals("true", StringComparison.OrdinalIgnoreCase) || value == "1";
                    break;
                default:
                    throw new FormatException($"OpenReceive connection string has an unknown key '{key}'. Expected type=openreceive;nwc=<NWC URI>[;allow-spend=true].");
            }
        }
        if (string.IsNullOrEmpty(nwc))
        {
            throw new FormatException("OpenReceive connection string is missing nwc=<NWC URI>. Expected type=openreceive;nwc=nostr+walletconnect://…");
        }
        return new OpenReceiveConnectionString(nwc, allowSpend);
    }

    /// <summary>The same string with the NWC secret redacted, for display and logs.</summary>
    public static string Redact(string connectionString)
    {
        var parsed = Parse(connectionString);
        return parsed is null
            ? connectionString
            : Format(Nwc.NwcUri.Redact(parsed.NwcUri), parsed.AllowSpendCapableWallet);
    }
}
