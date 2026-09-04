#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using NBitcoin.Secp256k1;
using NNostr.Client;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// A parsed <c>nostr+walletconnect:</c> connection string — the C# twin of core's
/// <c>parseNwcUri</c> / <c>redactNwcUri</c> and the host-facing message formatters in
/// <c>packages/js/core/src/nwc/client.ts</c>. Parsed by hand because <see cref="System.Uri"/>
/// mangles custom schemes. <see cref="Redacted"/> is the only form that may ever be logged.
/// </summary>
public sealed class NwcUri
{
    public const string Scheme = "nostr+walletconnect:";
    public const string RedactedSecret = "[REDACTED]";
    public const string CodeHelpUrl = "https://openreceive.org/get_a_nwc_code_to_receive_payments";

    private static readonly Regex Hex64 = new("^[0-9a-fA-F]{64}$", RegexOptions.Compiled);
    private static readonly Regex SchemePrefix = new("^[A-Za-z][A-Za-z0-9+.\\-]*:", RegexOptions.Compiled);

    /// <summary>64 hex characters, as written in the URI.</summary>
    public string WalletPubkey { get; }
    /// <summary>The wss relays, in URI order.</summary>
    public IReadOnlyList<Uri> Relays { get; }
    /// <summary>The relay URLs exactly as the URI spelled them.</summary>
    public IReadOnlyList<string> RelayUrls { get; }
    /// <summary>The client secret: 64 hex characters. Never log it.</summary>
    public string Secret { get; }
    public string? Lud16 { get; }
    /// <summary>The URI with every secret value replaced by <see cref="RedactedSecret"/>.</summary>
    public string Redacted { get; }
    /// <summary>The URI as given. Never log it; use <see cref="Redacted"/>.</summary>
    public string Raw { get; }

    private NwcUri(string raw, string walletPubkey, IReadOnlyList<string> relayUrls, string secret, string? lud16)
    {
        Raw = raw;
        WalletPubkey = walletPubkey;
        RelayUrls = relayUrls;
        Relays = relayUrls.Select(url => new Uri(url, UriKind.Absolute)).ToArray();
        Secret = secret;
        Lud16 = lud16;
        Redacted = Redact(raw);
    }

    /// <summary>The client's signing key (NIP-47 requests are signed and encrypted with it).</summary>
    public ECPrivKey SecretKey => NostrExtensions.ParseKey(Secret);

    /// <summary>The wallet service's x-only public key.</summary>
    public ECXOnlyPubKey WalletPubKey => NostrExtensions.ParsePubKey(WalletPubkey);

    public static bool TryParse(string uri, out NwcUri? parsed, out NwcUriParseException? error)
    {
        try
        {
            parsed = Parse(uri);
            error = null;
            return true;
        }
        catch (NwcUriParseException e)
        {
            parsed = null;
            error = e;
            return false;
        }
    }

    public static NwcUri Parse(string uri)
    {
        var schemeMatch = SchemePrefix.Match(uri);
        if (!schemeMatch.Success)
        {
            throw new NwcUriParseException("invalid_uri", "Invalid NWC URI.", uri);
        }
        if (!string.Equals(schemeMatch.Value, Scheme, StringComparison.OrdinalIgnoreCase))
        {
            throw new NwcUriParseException("invalid_scheme", "NWC URI must use nostr+walletconnect.", uri);
        }

        // Both `nostr+walletconnect://<pubkey>?…` and the opaque `nostr+walletconnect:<pubkey>?…`
        // carry the wallet pubkey up to the query (or fragment).
        var rest = uri[schemeMatch.Length..];
        if (rest.StartsWith("//", StringComparison.Ordinal)) rest = rest[2..];
        var headEnd = rest.IndexOfAny(new[] { '?', '#' });
        var head = headEnd == -1 ? rest : rest[..headEnd];
        var walletPubkey = head.TrimStart('/');
        var slash = walletPubkey.IndexOf('/');
        if (slash != -1) walletPubkey = walletPubkey[..slash];
        if (walletPubkey.Length == 0)
        {
            throw new NwcUriParseException("missing_wallet_pubkey", "NWC URI is missing the wallet public key.", uri);
        }
        if (!Hex64.IsMatch(walletPubkey))
        {
            throw new NwcUriParseException("invalid_wallet_pubkey", "NWC wallet public key must be 64 hex characters.", uri);
        }

        var query = QueryPairs(uri);
        var relays = query.Where(p => p.Key == "relay").Select(p => p.Value).ToArray();
        if (relays.Length == 0)
        {
            throw new NwcUriParseException("missing_relay", "NWC URI must include at least one relay.", uri);
        }
        if (relays.Any(relay => !IsValidRelayUrl(relay)))
        {
            throw new NwcUriParseException("invalid_relay", "NWC relay URLs must be valid wss URLs.", uri);
        }

        var secrets = query.Where(p => p.Key == "secret").Select(p => p.Value).ToArray();
        if (secrets.Length == 0 || secrets[0].Length == 0)
        {
            throw new NwcUriParseException("missing_secret", "NWC URI is missing the client secret.", uri);
        }
        if (secrets.Length != 1 || !Hex64.IsMatch(secrets[0]))
        {
            throw new NwcUriParseException("invalid_secret", "NWC client secret must be 64 hex characters.", uri);
        }

        var lud16 = query.FirstOrDefault(p => p.Key == "lud16").Value;
        if (string.IsNullOrEmpty(lud16)) lud16 = null;

        return new NwcUri(uri, walletPubkey, relays, secrets[0], lud16);
    }

    /// <summary>
    /// Replace every <c>secret=</c> value with <see cref="RedactedSecret"/>; every other byte
    /// of the URI is left exactly as it was, so the redacted form still identifies the connection.
    /// </summary>
    public static string Redact(string uri)
    {
        var queryStart = uri.IndexOf('?');
        if (queryStart == -1) return uri;

        var fragmentStart = uri.IndexOf('#', queryStart + 1);
        var queryEnd = fragmentStart == -1 ? uri.Length : fragmentStart;
        var query = uri[(queryStart + 1)..queryEnd];
        var redacted = string.Join("&", query.Split('&').Select(part =>
        {
            var separator = part.IndexOf('=');
            var key = separator == -1 ? part : part[..separator];
            return IsSecretQueryKey(key) ? $"{key}={RedactedSecret}" : part;
        }));
        return uri[..(queryStart + 1)] + redacted + uri[queryEnd..];
    }

    // ---- host-facing messages (ported verbatim from core; the last refusal line is BTCPay's) ----

    public static string FormatMissingNwcMessage(string? subject = null) => string.Join("\n",
        $"{subject ?? "OpenReceive"} needs a receive-only NWC code to receive payments.",
        "Set NWC_URI to your receive-only Nostr Wallet Connect connection string.",
        $"Get one here: {CodeHelpUrl}");

    public static string FormatInvalidNwcMessage(string? reason = null, string? subject = null)
    {
        var lines = new List<string> { $"{subject ?? "NWC_URI"} is set, but it is not a valid NWC code." };
        if (reason is not null) lines.Add($"Reason: {reason}");
        lines.Add($"Get a receive-only NWC code here: {CodeHelpUrl}");
        return string.Join("\n", lines);
    }

    public static string FormatSpendCapabilityRefusedMessage(IEnumerable<string>? spendMethods = null) => string.Join("\n",
        "This NWC connection is NOT receive-only.",
        $"The wallet info event advertises spend method(s): {NormalizedSpendMethods(spendMethods)}.",
        "A leaked spend-capable NWC code lets an attacker drain the wallet, so OpenReceive refuses to boot with it.",
        $"Get a receive-only NWC code here: {CodeHelpUrl}",
        "If this wallet cannot mint a receive-only code and you accept the risk, tick the override on the OpenReceive setup page (`;allow-spend=true` on the connection string).");

    public static string FormatSpendCapabilityWarningMessage(IEnumerable<string>? spendMethods = null) => string.Join("\n",
        "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
        "ERROR: This NWC connection is NOT receive-only.",
        $"The wallet info event advertises spend method(s): {NormalizedSpendMethods(spendMethods)}.",
        "OpenReceive must use a receive-only NWC code (no pay_invoice).",
        "Booting anyway because the spend-capable override is explicitly set.",
        $"Get a receive-only NWC code here: {CodeHelpUrl}",
        "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

    private static string NormalizedSpendMethods(IEnumerable<string>? spendMethods)
    {
        var methods = spendMethods?.ToArray();
        return string.Join(", ", methods is null || methods.Length == 0 ? new[] { "pay_invoice" } : methods);
    }

    // ---- query parsing, URLSearchParams-style ----

    private static List<KeyValuePair<string, string>> QueryPairs(string uri)
    {
        var pairs = new List<KeyValuePair<string, string>>();
        var queryStart = uri.IndexOf('?');
        if (queryStart == -1) return pairs;
        var fragmentStart = uri.IndexOf('#', queryStart + 1);
        var queryEnd = fragmentStart == -1 ? uri.Length : fragmentStart;
        foreach (var part in uri[(queryStart + 1)..queryEnd].Split('&'))
        {
            if (part.Length == 0) continue;
            var separator = part.IndexOf('=');
            var key = separator == -1 ? part : part[..separator];
            var value = separator == -1 ? "" : part[(separator + 1)..];
            pairs.Add(new KeyValuePair<string, string>(DecodeQueryComponent(key), DecodeQueryComponent(value)));
        }
        return pairs;
    }

    private static bool IsSecretQueryKey(string key) =>
        string.Equals(DecodeQueryComponent(key), "secret", StringComparison.OrdinalIgnoreCase);

    private static string DecodeQueryComponent(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static bool IsValidRelayUrl(string relay) =>
        relay.Length > 0
        && Uri.TryCreate(relay, UriKind.Absolute, out var parsed)
        && parsed.Scheme == "wss"
        && parsed.Host.Length > 0;
}

/// <summary>
/// A connection string that could not be parsed. <see cref="Message"/> is the human-readable
/// description and never contains the secret; <see cref="Redacted"/> is the loggable URI.
/// </summary>
public sealed class NwcUriParseException : Exception
{
    /// <summary>invalid_uri, invalid_scheme, missing_wallet_pubkey, invalid_wallet_pubkey, missing_relay, invalid_relay, missing_secret or invalid_secret.</summary>
    public string Code { get; }
    public string? Redacted { get; }

    public NwcUriParseException(string code, string description, string? uri = null) : base(description)
    {
        Code = code;
        Redacted = uri is null ? null : NwcUri.Redact(uri);
    }
}
