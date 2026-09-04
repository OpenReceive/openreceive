using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>Case lookup and canonical-JSON comparison shared by the vector classes.</summary>
internal static class VectorJson
{
    private static readonly JsonSerializerOptions Compact = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    public static TheoryData<string> Names(string fileName, string key = "cases")
    {
        var names = new TheoryData<string>();
        foreach (var item in TestVectors.Cases(fileName, key)) names.Add(item["name"]!.GetValue<string>());
        return names;
    }

    public static JsonObject Case(string fileName, string name, string key = "cases") =>
        TestVectors.Cases(fileName, key).First(item => item["name"]!.GetValue<string>() == name);

    /// <summary>Compact JSON with object keys sorted recursively, so two shapes compare as text.</summary>
    public static string Canonical(JsonNode? node) => Sorted(node)?.ToJsonString(Compact) ?? "null";

    private static JsonNode? Sorted(JsonNode? node) => node switch
    {
        JsonObject o => new JsonObject(o.OrderBy(p => p.Key, StringComparer.Ordinal)
            .Select(p => new KeyValuePair<string, JsonNode?>(p.Key, Sorted(p.Value)))),
        JsonArray a => new JsonArray(a.Select(Sorted).ToArray()),
        null => null,
        _ => node.DeepClone(),
    };

    /// <summary>A normalized transaction as the snake_case object the vectors describe; nulls omitted.</summary>
    public static JsonObject ToJson(NwcTransaction t)
    {
        var o = new JsonObject();
        if (t.Type is not null) o["type"] = t.Type;
        if (t.Invoice is not null) o["invoice"] = t.Invoice;
        if (t.PaymentHash is not null) o["payment_hash"] = t.PaymentHash;
        if (t.AmountMsats is { } amount) o["amount_msats"] = amount;
        if (t.TransactionState is not null) o["transaction_state"] = t.TransactionState;
        if (t.State is not null) o["state"] = t.State;
        if (t.CreatedAt is { } createdAt) o["created_at"] = createdAt;
        if (t.ExpiresAt is { } expiresAt) o["expires_at"] = expiresAt;
        if (t.SettledAt is { } settledAt) o["settled_at"] = settledAt;
        if (t.Preimage is not null) o["preimage"] = t.Preimage;
        if (t.Description is not null) o["description"] = t.Description;
        if (t.DescriptionHash is not null) o["description_hash"] = t.DescriptionHash;
        if (t.FeesPaidMsats is { } fees) o["fees_paid_msats"] = fees;
        return o;
    }

    public static string? OptionalString(JsonNode? node) => node?.GetValue<string>();

    public static long? OptionalLong(JsonNode? node) => node?.GetValue<long>();

    public static string[] Strings(JsonNode? node) =>
        node is JsonArray a ? a.Select(x => x!.GetValue<string>()).ToArray() : Array.Empty<string>();

    /// <summary>A valid receive-only connection for vectors that only need a wallet identity.</summary>
    public static NwcUri Connection() => NwcUri.Parse(
        "nostr+walletconnect://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
        "?relay=wss%3A%2F%2Frelay.example.com&secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
}
