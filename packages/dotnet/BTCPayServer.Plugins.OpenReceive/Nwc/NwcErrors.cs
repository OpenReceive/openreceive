#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>One wallet failure in OpenReceive's canonical vocabulary (<see cref="OpenReceiveTables.ErrorCodes"/>).</summary>
public sealed record NwcWalletError(string Code, string Message, bool Retryable, string? RequestId);

/// <summary>
/// NWC failure normalization — the C# twin of <c>packages/js/node/src/nwc/errors.ts</c>: the
/// wallet-error alias table and the record walk (error → result → cause → data) that turns any
/// error envelope or thrown exception into one <see cref="NwcWalletError"/>.
/// </summary>
public static class NwcErrors
{
    private static readonly Regex CamelBoundary = new("([a-z0-9])([A-Z])", RegexOptions.Compiled);
    private static readonly Regex NonAlphanumeric = new("[^a-zA-Z0-9]+", RegexOptions.Compiled);
    private static readonly string[] RecordChildren = { "error", "result", "cause", "data" };

    private static readonly IReadOnlyDictionary<string, string> Aliases = new Dictionary<string, string>
    {
        ["ABORT_ERROR"] = "TIMEOUT",
        ["BAD_REQUEST"] = "INVALID_REQUEST",
        ["CONNECTION_ERROR"] = "WALLET_UNAVAILABLE",
        ["EXPIRED"] = "INVOICE_EXPIRED",
        ["FETCH_ERROR"] = "WALLET_UNAVAILABLE",
        ["FORBIDDEN"] = "RESTRICTED",
        ["INVOICE_NOT_FOUND"] = "NOT_FOUND",
        ["INVALID_PARAMETER"] = "INVALID_REQUEST",
        ["INVALID_PARAMETERS"] = "INVALID_REQUEST",
        ["INVALID_PARAMS"] = "INVALID_REQUEST",
        ["METHOD_NOT_FOUND"] = "UNSUPPORTED_METHOD",
        ["NETWORK_ERROR"] = "WALLET_UNAVAILABLE",
        ["NIP47_NETWORK_ERROR"] = "WALLET_UNAVAILABLE",
        ["NOSTR_NETWORK_ERROR"] = "WALLET_UNAVAILABLE",
        ["NOT_AUTHORIZED"] = "UNAUTHORIZED",
        ["NOT_SUPPORTED"] = "UNSUPPORTED_METHOD",
        ["NOTFOUND"] = "NOT_FOUND",
        ["PERMISSION_DENIED"] = "RESTRICTED",
        ["RELAY_CONNECTION_ERROR"] = "WALLET_UNAVAILABLE",
        ["REQUEST_TIMEOUT"] = "TIMEOUT",
        ["SERVICE_UNAVAILABLE"] = "WALLET_UNAVAILABLE",
        ["TIMED_OUT"] = "TIMEOUT",
        ["TIMEOUT_ERROR"] = "TIMEOUT",
        ["UNKNOWN_METHOD"] = "UNSUPPORTED_METHOD",
        ["UNSUPPORTED"] = "UNSUPPORTED_METHOD",
        ["UNSUPPORTED_ENCRYPTION_MODE"] = "UNSUPPORTED_ENCRYPTION",
        ["WALLET_OFFLINE"] = "WALLET_UNAVAILABLE",
        ["WALLET_UNREACHABLE"] = "WALLET_UNAVAILABLE",
    };

    private static readonly IReadOnlyDictionary<string, string> Messages = new Dictionary<string, string>
    {
        ["NOT_IMPLEMENTED"] = "NWC wallet service does not implement this method.",
        ["RESTRICTED"] = "NWC wallet service restricted this request.",
        ["UNAUTHORIZED"] = "NWC wallet service rejected authorization.",
        ["FORBIDDEN"] = "The host application did not authorize this request.",
        ["RATE_LIMITED"] = "NWC wallet service rate limited this request.",
        ["QUOTA_EXCEEDED"] = "NWC wallet service quota was exceeded.",
        ["INTERNAL"] = "NWC wallet service returned an internal error.",
        ["UNSUPPORTED_ENCRYPTION"] = "NWC wallet service does not support the required encryption mode.",
        ["OTHER"] = "NWC wallet service returned an unknown error.",
        ["NOT_FOUND"] = "NWC wallet service could not find the requested resource.",
        ["TIMEOUT"] = "NWC wallet service request timed out.",
        ["INVALID_REQUEST"] = "OpenReceive sent an invalid NWC wallet request.",
        ["WALLET_UNAVAILABLE"] = "NWC wallet service is unavailable.",
        ["INVOICE_EXPIRED"] = "NWC wallet reported that the invoice is expired.",
        ["UNSUPPORTED_METHOD"] = "NWC wallet service does not support the requested method.",
        ["CONFLICT"] = "NWC wallet service reported a conflicting request.",
    };

    /// <summary>Normalize a raw error envelope (a NIP-47 <c>error</c> object, a library error, or a bare string).</summary>
    public static NwcWalletError Normalize(JsonNode rawError)
    {
        var records = CollectRecords(rawError);
        var bareText = rawError is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        var code = CodeFromRecords(records) ?? (bareText is null ? null : NormalizeCode(bareText)) ?? "OTHER";
        return Build(records, code, bareText);
    }

    /// <summary>Normalize a thrown exception: our own transport/validation types first, then the same record walk over type names and messages.</summary>
    public static NwcWalletError Normalize(Exception error)
    {
        var records = CollectRecords(error);
        var code = KnownCode(error) ?? CodeFromRecords(records) ?? "OTHER";
        return Build(records, code, null);
    }

    /// <summary>Uppercase snake_case: <c>Nip47NetworkError</c> → <c>NIP47_NETWORK_ERROR</c>, <c>insufficient-balance</c> → <c>INSUFFICIENT_BALANCE</c>.</summary>
    public static string NormalizeCodeText(string value)
    {
        var text = CamelBoundary.Replace(value.Trim(), "$1_$2");
        text = NonAlphanumeric.Replace(text, "_").Trim('_');
        return text.ToUpperInvariant();
    }

    /// <summary>The canonical code for a wallet/library code, or null when it is not one we know. Aliases win: a wallet's own FORBIDDEN is RESTRICTED, never the host's FORBIDDEN.</summary>
    public static string? NormalizeCode(string? value)
    {
        if (value is null || value.Trim().Length == 0) return null;
        var normalized = NormalizeCodeText(value);
        if (Aliases.TryGetValue(normalized, out var alias)) return alias;
        return OpenReceiveTables.ErrorCodes.Contains(normalized) ? normalized : null;
    }

    private static NwcWalletError Build(IReadOnlyList<JsonObject> records, string code, string? bareText)
    {
        var message = MessageFromRecords(records, code, bareText);
        var retryable = FirstBoolean(records, "retryable") ?? OpenReceiveTables.RetryableErrorCodes.Contains(code);
        var requestId = FirstString(records, "request_id", "requestId");
        return new NwcWalletError(code, message, retryable, requestId);
    }

    private static string? KnownCode(Exception error) => error switch
    {
        NwcValidationException => "INVALID_REQUEST",
        NwcTransportException => "WALLET_UNAVAILABLE",
        TimeoutException => "TIMEOUT",
        OperationCanceledException => "TIMEOUT",
        _ => null,
    };

    private static string? CodeFromRecords(IReadOnlyList<JsonObject> records)
    {
        foreach (var record in records)
        {
            var directCode = NormalizeCode(Text(record["code"]))
                ?? NormalizeCode(Text(record["error_code"]))
                ?? NormalizeCode(Text(record["errorCode"]))
                ?? NormalizeCode(Text(record["type"]));
            if (directCode is not null && directCode != "OTHER") return directCode;

            var nameCode = NormalizeCode(Text(record["name"]));
            if (nameCode is not null && nameCode != "OTHER") return nameCode;
            if (directCode is not null) return directCode;
        }
        return null;
    }

    private static string MessageFromRecords(IReadOnlyList<JsonObject> records, string code, string? bareText)
    {
        var message = FirstString(records, "message", "description", "reason");
        if (message is not null && NormalizeCode(message) != code) return message;
        if (bareText is not null && NormalizeCode(bareText) is null && bareText.Trim().Length > 0) return bareText.Trim();
        return Messages[code];
    }

    private static IReadOnlyList<JsonObject> CollectRecords(JsonNode? value)
    {
        var records = new List<JsonObject>();
        Collect(value, records);
        return records;

        static void Collect(JsonNode? node, List<JsonObject> into)
        {
            if (node is not JsonObject record) return;
            into.Add(record);
            foreach (var key in RecordChildren) Collect(record[key], into);
        }
    }

    /// <summary>An exception as the same record shape: its type name, message, our own code, and its inner exception as <c>cause</c>.</summary>
    private static IReadOnlyList<JsonObject> CollectRecords(Exception error)
    {
        var records = new List<JsonObject>();
        for (var current = error; current is not null; current = current.InnerException)
        {
            var record = new JsonObject
            {
                ["name"] = current.GetType().Name,
                ["message"] = current.Message,
            };
            if (current is NwcRequestException request) record["code"] = request.Code;
            records.Add(record);
        }
        return records;
    }

    private static string? Text(JsonNode? value) => value is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static string? FirstString(IReadOnlyList<JsonObject> records, params string[] fields) =>
        records.SelectMany(record => fields.Select(field => Text(record[field])))
            .FirstOrDefault(text => text is not null && text.Trim().Length > 0);

    private static bool? FirstBoolean(IReadOnlyList<JsonObject> records, string field)
    {
        foreach (var record in records)
        {
            if (record[field] is JsonValue v && v.TryGetValue<bool>(out var b)) return b;
        }
        return null;
    }
}
