#nullable enable
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// NIP-47 request building, request validation and reply normalization — the C# twin of
/// <c>packages/js/node/src/nwc/normalize.ts</c>. Pure functions over JSON the wallet already
/// returned. Absent means absent; a value the wallet DID send and we cannot read throws
/// <see cref="NwcNormalizeException"/>, and the caller decides whether to skip the row.
/// </summary>
public static class NwcNormalize
{
    private static readonly Regex Hex64 = new("^[0-9a-fA-F]{64}$", RegexOptions.Compiled);
    private static readonly Regex Digits = new("^[0-9]+$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions CompactJson = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    // ---- requests ----

    public static JsonObject ToMakeInvoiceParams(MakeInvoiceRequest request)
    {
        if (request.AmountMsats > OpenReceiveTables.MaxAmountMsats)
        {
            throw new NwcValidationException("amount_too_large", "amount_msats exceeds JSON safe integer boundary");
        }
        var parameters = new JsonObject { ["amount"] = request.AmountMsats };
        if (request.Description is not null) parameters["description"] = request.Description;
        if (request.DescriptionHash is not null) parameters["description_hash"] = request.DescriptionHash;
        if (request.Expiry is { } expiry) parameters["expiry"] = expiry;
        if (request.MetadataJson is not null) parameters["metadata"] = JsonNode.Parse(request.MetadataJson);
        return parameters;
    }

    public static JsonObject ToListTransactionsParams(ListTransactionsRequest request)
    {
        var parameters = new JsonObject();
        if (request.From is { } from) parameters["from"] = from;
        if (request.Until is { } until) parameters["until"] = until;
        if (request.Limit is { } limit) parameters["limit"] = limit;
        if (request.Offset is { } offset) parameters["offset"] = offset;
        if (request.Unpaid is { } unpaid) parameters["unpaid"] = unpaid;
        if (request.Type is not null) parameters["type"] = request.Type;
        return parameters;
    }

    public static void ValidateMakeInvoiceRequest(MakeInvoiceRequest request)
    {
        if (request.AmountMsats < OpenReceiveTables.MinAmountMsats)
        {
            throw new NwcValidationException("amount_too_small", $"amount_msats must be at least {OpenReceiveTables.MinAmountMsats}");
        }
        if (request.AmountMsats > OpenReceiveTables.MaxAmountMsats)
        {
            throw new NwcValidationException("amount_too_large", "amount_msats exceeds JSON safe integer boundary");
        }
        if (request.Description is not null && request.DescriptionHash is not null)
        {
            throw new NwcValidationException("description_conflict", "At most one of description or description_hash may be present");
        }
        if (request.DescriptionHash is not null && !Hex64.IsMatch(request.DescriptionHash))
        {
            throw new NwcValidationException("invalid_description_hash", "description_hash must be 64 hex characters");
        }
        if (request.MetadataJson is not null)
        {
            var compact = JsonNode.Parse(request.MetadataJson)?.ToJsonString(CompactJson) ?? "null";
            if (Encoding.UTF8.GetByteCount(compact) > OpenReceiveTables.NwcMetadataMaxBytes)
            {
                throw new NwcValidationException("metadata_too_large", $"metadata must serialize below {OpenReceiveTables.NwcMetadataMaxBytes} bytes");
            }
        }
    }

    // ---- replies ----

    public static MakeInvoiceResult MakeInvoice(JsonNode? raw)
    {
        var result = Record(Unwrap(raw));
        var invoice = RequiredString(First(result, "invoice"), "invoice");
        var paymentHash = RequiredString(First(result, "payment_hash", "paymentHash"), "payment_hash");
        if (!Hex64.IsMatch(paymentHash)) throw new NwcNormalizeException("payment_hash must be 64 hex characters");
        // amount_msats is read BEFORE the optional timestamps so a wallet returning several
        // malformed fields still hears about the amount — the field that decides what is owed — first.
        var amountMsats = ToInteger(First(result, "amount_msats", "amount"), "amount_msats");
        var createdAt = OptionalInteger(First(result, "created_at", "createdAt"), "created_at");
        var expiresAt = OptionalInteger(First(result, "expires_at", "expiresAt"), "expires_at");
        return new MakeInvoiceResult
        {
            Invoice = invoice,
            PaymentHash = paymentHash,
            AmountMsats = amountMsats,
            CreatedAt = createdAt,
            ExpiresAt = expiresAt,
        };
    }

    public static ListTransactionsResult ListTransactions(JsonNode? raw)
    {
        var unwrapped = Unwrap(raw);
        var result = Record(unwrapped);
        JsonArray rawTransactions;
        if (result["transactions"] is JsonArray under)
        {
            rawTransactions = under;
        }
        else if (unwrapped is JsonArray bare)
        {
            rawTransactions = bare;
        }
        else if ((unwrapped is null || unwrapped is JsonObject) && result.Count == 0)
        {
            // A genuinely empty reply is an empty scan.
            rawTransactions = new JsonArray();
        }
        else
        {
            // A non-empty reply in a shape we do not recognize must NOT read as an empty scan:
            // an empty-looking scan at/after expiry+grace closes pending attempts as expired.
            throw new NwcNormalizeException("list_transactions returned an unrecognized result shape");
        }

        // One quirky wallet row must never reject the whole scan; bad rows are skipped and counted.
        var transactions = new List<NwcTransaction>();
        var skippedRows = 0;
        foreach (var row in rawTransactions)
        {
            try
            {
                transactions.Add(Transaction(row));
            }
            catch (NwcNormalizeException)
            {
                skippedRows += 1;
            }
        }
        // ALL rows unusable is the unrecognized-shape case wearing a different hat.
        if (transactions.Count == 0 && skippedRows > 0)
        {
            throw new NwcNormalizeException("list_transactions returned no usable rows");
        }
        return new ListTransactionsResult { Transactions = transactions, SkippedRows = skippedRows };
    }

    public static NwcTransaction Transaction(JsonNode? raw)
    {
        var result = Record(raw);

        var paymentHash = NonEmptyString(First(result, "payment_hash", "paymentHash"));
        if (paymentHash is not null && !Hex64.IsMatch(paymentHash))
        {
            throw new NwcNormalizeException("payment_hash must be 64 hexadecimal characters");
        }

        long? amountMsats = null;
        if (result.ContainsKey("amount_msats") || result.ContainsKey("amount"))
        {
            amountMsats = ToInteger(First(result, "amount_msats", "amount"), "amount_msats");
        }

        // Map common wallet-library field spellings to the normalized transaction_state.
        var transactionState = NormalizeTransactionState(First(result, "transaction_state", "transactionState", "state"))
            ?? (IsTrue(result["settled"]) || IsTrue(result["paid"]) ? "settled" : null);

        var createdAt = OptionalUnixSeconds(First(result, "created_at", "createdAt"), "created_at");
        var expiresAt = OptionalUnixSeconds(First(result, "expires_at", "expiresAt"), "expires_at");
        var settledAt = OptionalUnixSeconds(First(result, "settled_at", "settledAt"), "settled_at");

        long? feesPaid = null;
        if (result.ContainsKey("fees_paid") || result.ContainsKey("feesPaid"))
        {
            feesPaid = ToInteger(First(result, "fees_paid", "feesPaid"), "fees_paid");
        }

        return new NwcTransaction
        {
            Type = NormalizeTransactionType(result["type"]),
            Invoice = NonEmptyString(result["invoice"]),
            PaymentHash = paymentHash,
            AmountMsats = amountMsats,
            TransactionState = transactionState,
            CreatedAt = createdAt,
            ExpiresAt = expiresAt,
            SettledAt = settledAt,
            Preimage = NonEmptyString(result["preimage"]),
            Description = NonEmptyString(result["description"]),
            DescriptionHash = NonEmptyString(First(result, "description_hash", "descriptionHash")),
            FeesPaidMsats = feesPaid,
        };
    }

    public static NwcWalletNotification Notification(JsonNode? raw)
    {
        var record = Record(raw);
        var type = StringOrNull(First(record, "notification_type", "notificationType", "type")) ?? "unknown";
        var payload = Record(record["notification"]);
        NwcTransaction? transaction = null;
        if (payload.Count > 0)
        {
            try
            {
                transaction = Transaction(payload);
            }
            catch (NwcNormalizeException)
            {
                // A malformed payload never settles anything and never breaks the subscription;
                // the hash (when present) still wakes reconciliation.
            }
        }
        var paymentHash = NonEmptyString(First(payload, "payment_hash", "paymentHash") ?? First(record, "payment_hash", "paymentHash"))
            ?? transaction?.PaymentHash;
        return new NwcWalletNotification { Type = type, PaymentHash = paymentHash, Transaction = transaction };
    }

    /// <summary>pending, settled, expired, failed or accepted (lowercased); anything else is null.</summary>
    public static string? NormalizeTransactionState(JsonNode? value)
    {
        var text = StringOrNull(value)?.ToLowerInvariant();
        return text is "pending" or "settled" or "expired" or "failed" or "accepted" ? text : null;
    }

    // ---- JSON helpers shared with NwcInfo / NwcErrors ----

    /// <summary>The <c>result</c> member of a NIP-47 envelope, or the value itself.</summary>
    public static JsonNode? Unwrap(JsonNode? value) => value is JsonObject record ? record["result"] ?? value : value;

    /// <summary>The value as an object, or an empty object.</summary>
    public static JsonObject Record(JsonNode? value) => value as JsonObject ?? new JsonObject();

    private static JsonNode? First(JsonObject record, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (record[key] is { } value) return value;
        }
        return null;
    }

    private static string? StringOrNull(JsonNode? value) =>
        value is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static string? NonEmptyString(JsonNode? value) =>
        StringOrNull(value) is { Length: > 0 } s ? s : null;

    private static bool IsTrue(JsonNode? value) =>
        value is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static string? NormalizeTransactionType(JsonNode? value)
    {
        var text = StringOrNull(value)?.ToLowerInvariant();
        return text is "incoming" or "outgoing" ? text : null;
    }

    private static string RequiredString(JsonNode? value, string fieldName) =>
        NonEmptyString(value) ?? throw new NwcNormalizeException($"{fieldName} must be a non-empty string");

    /// <summary>Absent stays absent; anything present must be a non-negative safe integer.</summary>
    private static long? OptionalInteger(JsonNode? value, string fieldName)
    {
        if (value is null) return null;
        if (TryNumber(value, out var number) && IsSafeInteger(number) && number >= 0) return (long)number;
        throw new NwcNormalizeException($"{fieldName} must be a non-negative safe integer");
    }

    /// <summary>Absent stays absent; present must be a non-negative number. Fractional seconds floor.</summary>
    private static long? OptionalUnixSeconds(JsonNode? value, string fieldName)
    {
        if (value is null) return null;
        if (TryNumber(value, out var number) && double.IsFinite(number) && number >= 0) return (long)Math.Floor(number);
        throw new NwcNormalizeException($"{fieldName} must be a non-negative number of Unix seconds");
    }

    /// <summary>A JSON number that is a safe integer, or a string of digits.</summary>
    private static long ToInteger(JsonNode? value, string fieldName)
    {
        if (value is JsonValue v)
        {
            if (TryNumber(value, out var number))
            {
                if (IsSafeInteger(number)) return (long)number;
            }
            else if (v.TryGetValue<string>(out var text) && Digits.IsMatch(text) && long.TryParse(text, out var parsed))
            {
                return parsed;
            }
        }
        throw new NwcNormalizeException($"{fieldName} must be an integer");
    }

    private static bool IsSafeInteger(double number) =>
        double.IsFinite(number) && Math.Floor(number) == number && Math.Abs(number) <= OpenReceiveTables.MaxAmountMsats;

    /// <summary>Reads a JSON number whether it was parsed from text or created in code.</summary>
    private static bool TryNumber(JsonNode value, out double number)
    {
        number = 0;
        if (value is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return false;
        if (v.TryGetValue<long>(out var l)) { number = l; return true; }
        if (v.TryGetValue<int>(out var i)) { number = i; return true; }
        if (v.TryGetValue<double>(out var d)) { number = d; return true; }
        if (v.TryGetValue<decimal>(out var m)) { number = (double)m; return true; }
        return false;
    }
}

/// <summary>A wallet reply carried a field we could not read.</summary>
public sealed class NwcNormalizeException : Exception
{
    public NwcNormalizeException(string message) : base(message) { }
}

/// <summary>A request OpenReceive would have sent is invalid; nothing reached the wallet.</summary>
public sealed class NwcValidationException : Exception
{
    /// <summary>amount_too_small, amount_too_large, description_conflict, invalid_description_hash or metadata_too_large.</summary>
    public string Code { get; }

    public NwcValidationException(string code, string message) : base(message)
    {
        Code = code;
    }
}
