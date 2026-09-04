#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>One parsed Lightning Swap Connect credential. <see cref="Secret"/> never belongs in a log line.</summary>
public sealed record LscConnection(string BaseUrl, string ProviderId, string Key, string Secret)
{
    /// <summary>The provider's host name, for the local-network policy.</summary>
    public string Host => new Uri(BaseUrl).DnsSafeHost;
}

/// <summary>
/// Lightning Swap Connect URIs: <c>lightning+swapconnect://host[:port][/path]?key=…&amp;secret=…</c>.
/// Parsed by hand because the framework URI parser is unreliable with custom
/// schemes. Error messages never include the credential values.
/// </summary>
public static partial class LscUri
{
    public const string Protocol = "lightning+swapconnect:";

    private const int MaxUriLength = 8_192;
    private const int MaxCredentialLength = 2_048;
    private static readonly HashSet<string> QueryParameters = new(StringComparer.Ordinal) { "key", "secret" };

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9+.-]*$")]
    private static partial Regex SchemePattern();

    [GeneratedRegex("%(?![0-9a-fA-F]{2})")]
    private static partial Regex MalformedPercentPattern();

    [GeneratedRegex("[^a-z0-9_-]+")]
    private static partial Regex ProviderIdJunkPattern();

    public static LscConnection Parse(string value)
    {
        var input = RequiredCredential(value, "LSC URI", MaxUriLength);

        var colon = input.IndexOf(':');
        if (colon <= 0 || !SchemePattern().IsMatch(input[..colon]))
        {
            throw new FormatException("LSC URI is not a valid absolute URI.");
        }
        var protocol = input[..(colon + 1)].ToLowerInvariant();
        if (!string.Equals(protocol, Protocol, StringComparison.Ordinal))
        {
            throw new FormatException($"LSC URI must use {Protocol}//.");
        }

        var rest = input[(colon + 1)..];
        var fragment = string.Empty;
        var hash = rest.IndexOf('#');
        if (hash >= 0)
        {
            fragment = rest[(hash + 1)..];
            rest = rest[..hash];
        }
        var query = string.Empty;
        var question = rest.IndexOf('?');
        if (question >= 0)
        {
            query = rest[(question + 1)..];
            rest = rest[..question];
        }

        var authority = string.Empty;
        var path = string.Empty;
        if (rest.StartsWith("//", StringComparison.Ordinal))
        {
            var afterSlashes = rest[2..];
            var slash = afterSlashes.IndexOf('/');
            authority = slash < 0 ? afterSlashes : afterSlashes[..slash];
            path = slash < 0 ? string.Empty : afterSlashes[slash..];
        }

        if (authority.Contains('@'))
        {
            throw new FormatException("LSC URI must not use URI userinfo.");
        }
        var (hostname, port) = SplitHostAndPort(authority);
        if (hostname.Length == 0)
        {
            throw new FormatException("LSC URI requires a provider hostname.");
        }
        if (fragment.Length > 0)
        {
            throw new FormatException("LSC URI must not contain a fragment.");
        }
        if (MalformedPercentPattern().IsMatch(query))
        {
            throw new FormatException("LSC URI query encoding is invalid.");
        }

        var parameters = ParseQuery(query);
        foreach (var (name, _) in parameters)
        {
            if (!QueryParameters.Contains(name))
            {
                throw new FormatException("LSC URI contains an unsupported query parameter.");
            }
        }

        var key = RequiredCredential(SingleParameter(parameters, "key"), "LSC URI key", MaxCredentialLength);
        var secret = RequiredCredential(SingleParameter(parameters, "secret"), "LSC URI secret", MaxCredentialLength);
        var host = port is null ? hostname : $"{hostname}:{port}";
        var baseUrl = $"https://{host}{NormalizeEndpointPath(path)}";

        return new LscConnection(baseUrl, ProviderIdFrom(hostname, port, path), key, secret);
    }

    public static bool TryParse(string value, out LscConnection? connection, out string? error)
    {
        try
        {
            connection = Parse(value);
            error = null;
            return true;
        }
        catch (FormatException exception)
        {
            connection = null;
            error = exception.Message;
            return false;
        }
    }

    /// <summary>The URI with both credentials masked, for display: <c>lightning+swapconnect://host/path/?key=…&amp;secret=…</c>.</summary>
    public static string Redact(string value) =>
        TryParse(value, out var connection, out _) && connection is not null
            ? $"{Protocol}//{connection.BaseUrl["https://".Length..]}?key=…&secret=…"
            : $"{Protocol}//…";

    public static string Format(string baseUrl, string key, string secret)
    {
        var endpoint = ParseHttpsEndpoint(baseUrl);
        var normalizedKey = RequiredCredential(key, "LSC key", MaxCredentialLength);
        var normalizedSecret = RequiredCredential(secret, "LSC secret", MaxCredentialLength);
        var host = endpoint.IsDefaultPort ? endpoint.Host : $"{endpoint.Host}:{endpoint.Port.ToString(CultureInfo.InvariantCulture)}";
        return $"{Protocol}//{host}{NormalizeEndpointPath(endpoint.AbsolutePath)}" +
               $"?key={FormUrlEncode(normalizedKey)}&secret={FormUrlEncode(normalizedSecret)}";
    }

    private static (string Hostname, string? Port) SplitHostAndPort(string authority)
    {
        if (authority.Length == 0) return (string.Empty, null);
        string hostname;
        string? port = null;
        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']');
            if (close < 0) throw new FormatException("LSC URI is not a valid absolute URI.");
            hostname = authority[..(close + 1)];
            var tail = authority[(close + 1)..];
            if (tail.Length > 0)
            {
                if (!tail.StartsWith(':')) throw new FormatException("LSC URI is not a valid absolute URI.");
                port = tail[1..];
            }
        }
        else
        {
            var colon = authority.LastIndexOf(':');
            hostname = colon < 0 ? authority : authority[..colon];
            port = colon < 0 ? null : authority[(colon + 1)..];
        }
        foreach (var character in hostname)
        {
            if (character <= ' ' || character == (char)0x7f || "#/<>?@\\^|".Contains(character))
            {
                throw new FormatException("LSC URI is not a valid absolute URI.");
            }
        }
        if (port is not null)
        {
            if (port.Length == 0)
            {
                port = null;
            }
            else if (!port.All(char.IsAsciiDigit) || !ushort.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out _))
            {
                throw new FormatException("LSC URI is not a valid absolute URI.");
            }
        }
        return (hostname, port);
    }

    private static List<(string Name, string Value)> ParseQuery(string query)
    {
        var parameters = new List<(string, string)>();
        foreach (var piece in query.Split('&'))
        {
            if (piece.Length == 0) continue;
            var equals = piece.IndexOf('=');
            var name = equals < 0 ? piece : piece[..equals];
            var value = equals < 0 ? string.Empty : piece[(equals + 1)..];
            parameters.Add((FormUrlDecode(name), FormUrlDecode(value)));
        }
        return parameters;
    }

    private static string SingleParameter(List<(string Name, string Value)> parameters, string name)
    {
        string? found = null;
        var count = 0;
        foreach (var (parameterName, value) in parameters)
        {
            if (!string.Equals(parameterName, name, StringComparison.Ordinal)) continue;
            count += 1;
            found ??= value;
        }
        if (count != 1)
        {
            throw new FormatException($"LSC URI requires exactly one {name} parameter.");
        }
        return found ?? string.Empty;
    }

    private static string RequiredCredential(string value, string label, int maximumLength)
    {
        var normalized = value.Trim();
        if (normalized.Length == 0) throw new FormatException($"{label} must not be empty.");
        if (normalized.Length > maximumLength) throw new FormatException($"{label} is too long.");
        return normalized;
    }

    private static Uri ParseHttpsEndpoint(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var endpoint))
        {
            throw new FormatException("LSC baseUrl must be a valid HTTPS URL.");
        }
        if (!string.Equals(endpoint.Scheme, "https", StringComparison.Ordinal) ||
            endpoint.Host.Length == 0 ||
            endpoint.UserInfo.Length > 0 ||
            endpoint.Query.Length > 0 ||
            endpoint.Fragment.Length > 0)
        {
            throw new FormatException("LSC baseUrl must be an HTTPS URL without userinfo, query parameters, or a fragment.");
        }
        return endpoint;
    }

    private static string NormalizeEndpointPath(string pathname)
    {
        if (pathname.Length == 0 || pathname == "/") return "/";
        return pathname.EndsWith('/') ? pathname : pathname + "/";
    }

    private static string ProviderIdFrom(string hostname, string? port, string pathname)
    {
        var path = string.Join('-', pathname.Split('/', StringSplitOptions.RemoveEmptyEntries));
        var raw = $"{hostname}{(port is null ? string.Empty : "-" + port)}{(path.Length == 0 ? string.Empty : "-" + path)}"
            .ToLowerInvariant();
        raw = ProviderIdJunkPattern().Replace(raw, "-").Trim('-');
        if (raw.Length > 64) raw = raw[..64];
        if (raw.Length == 0) throw new FormatException("LSC URI could not derive a provider id.");
        return raw;
    }

    /// <summary>application/x-www-form-urlencoded decoding: '+' is a space, %XX is a byte.</summary>
    private static string FormUrlDecode(string value)
    {
        var bytes = new List<byte>(value.Length);
        for (var i = 0; i < value.Length; i += 1)
        {
            var character = value[i];
            if (character == '+')
            {
                bytes.Add((byte)' ');
            }
            else if (character == '%' && i + 2 < value.Length &&
                     Uri.IsHexDigit(value[i + 1]) && Uri.IsHexDigit(value[i + 2]))
            {
                bytes.Add(byte.Parse(value.AsSpan(i + 1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                i += 2;
            }
            else
            {
                bytes.AddRange(Encoding.UTF8.GetBytes(character.ToString()));
            }
        }
        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    /// <summary>application/x-www-form-urlencoded encoding, as URLSearchParams serializes it.</summary>
    private static string FormUrlEncode(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var character = (char)b;
            if (b == ' ')
            {
                builder.Append('+');
            }
            else if (char.IsAsciiLetterOrDigit(character) || character is '*' or '-' or '.' or '_')
            {
                builder.Append(character);
            }
            else
            {
                builder.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }
        return builder.ToString();
    }
}
