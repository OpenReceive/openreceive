using System.Text.Json.Nodes;

namespace OpenReceive.TestkitNwc;

/// <summary>NIP-47 wire shapes: result/error envelopes and the transaction object.</summary>
public static class Nip47Json
{
    public const string PaymentReceived = "payment_received";

    public static JsonObject Result(string method, JsonNode result) => new()
    {
        ["result_type"] = method,
        ["result"] = result,
    };

    public static JsonObject Error(string method, string code, string message) => new()
    {
        ["result_type"] = method,
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };

    /// <summary>Transaction JSON; preimage and settled_at appear only once the invoice is settled.</summary>
    public static JsonObject Transaction(WalletInvoice invoice, JsonObject? metadata = null)
    {
        var tx = new JsonObject
        {
            ["type"] = "incoming",
            ["invoice"] = invoice.Bolt11,
            ["description"] = invoice.Description,
            ["description_hash"] = invoice.DescriptionHash,
            ["payment_hash"] = invoice.PaymentHash,
            ["amount"] = invoice.AmountMsats,
            ["fees_paid"] = 0L,
            ["created_at"] = invoice.CreatedAt,
            ["expires_at"] = invoice.ExpiresAt,
            ["state"] = invoice.State,
        };
        if (invoice.IsSettled)
        {
            tx["preimage"] = invoice.Preimage;
            tx["settled_at"] = invoice.SettledAt;
        }
        if (metadata is not null)
            tx["metadata"] = metadata.DeepClone();
        return tx;
    }

    public static JsonObject Notification(WalletInvoice invoice, JsonObject? metadata = null) => new()
    {
        ["notification_type"] = PaymentReceived,
        ["notification"] = Transaction(invoice, metadata),
    };

    public static class ErrorCodes
    {
        public const string NotImplemented = "NOT_IMPLEMENTED";
        public const string Restricted = "RESTRICTED";
        public const string Unauthorized = "UNAUTHORIZED";
        public const string NotFound = "NOT_FOUND";
        public const string Internal = "INTERNAL";
        public const string UnsupportedEncryption = "UNSUPPORTED_ENCRYPTION";
        public const string Other = "OTHER";
    }
}
