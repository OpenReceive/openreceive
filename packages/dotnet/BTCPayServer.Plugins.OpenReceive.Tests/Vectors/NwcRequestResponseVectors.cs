using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>
/// spec/test-vectors/nwc-request-response.json: OpenReceive requests map to NIP-47 params
/// (<see cref="NwcNormalize.ToMakeInvoiceParams"/>, <see cref="NwcNormalize.ToListTransactionsParams"/>)
/// and raw replies normalize (<see cref="NwcNormalize.MakeInvoice"/>, <see cref="NwcNormalize.ListTransactions"/>).
/// Shapes are compared as canonical JSON with sorted keys.
/// </summary>
public sealed class NwcRequestResponseVectors
{
    private const string File = "nwc-request-response.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var method = c["method"]!.GetValue<string>();
        var request = c["openreceive_request"]!;
        var expectedRequest = VectorJson.Canonical(c["expected_nip47_request"]);
        var expectedResponse = VectorJson.Canonical(c["expected_openreceive_response"]);

        switch (method)
        {
            case "make_invoice":
            {
                var parameters = NwcNormalize.ToMakeInvoiceParams(new MakeInvoiceRequest
                {
                    AmountMsats = request["amount_msats"]!.GetValue<long>(),
                    Description = VectorJson.OptionalString(request["description"]),
                    DescriptionHash = VectorJson.OptionalString(request["description_hash"]),
                    Expiry = request["expiry"]?.GetValue<int>(),
                    MetadataJson = request["metadata"]?.ToJsonString(),
                });
                Assert.Equal(expectedRequest, VectorJson.Canonical(parameters));

                var result = NwcNormalize.MakeInvoice(c["raw_response"]);
                var response = new JsonObject
                {
                    ["invoice"] = result.Invoice,
                    ["payment_hash"] = result.PaymentHash,
                    ["amount_msats"] = result.AmountMsats,
                };
                if (result.CreatedAt is { } createdAt) response["created_at"] = createdAt;
                if (result.ExpiresAt is { } expiresAt) response["expires_at"] = expiresAt;
                Assert.Equal(expectedResponse, VectorJson.Canonical(response));
                return;
            }
            case "list_transactions":
            {
                var parameters = NwcNormalize.ToListTransactionsParams(new ListTransactionsRequest
                {
                    Type = VectorJson.OptionalString(request["type"]),
                    Unpaid = request["unpaid"]?.GetValue<bool>(),
                    From = VectorJson.OptionalLong(request["from"]),
                    Until = VectorJson.OptionalLong(request["until"]),
                    Limit = request["limit"]?.GetValue<int>(),
                    Offset = request["offset"]?.GetValue<int>(),
                });
                Assert.Equal(expectedRequest, VectorJson.Canonical(parameters));

                var result = NwcNormalize.ListTransactions(c["raw_response"]);
                Assert.Equal(0, result.SkippedRows);
                var response = new JsonObject
                {
                    ["transactions"] = new JsonArray(result.Transactions.Select(t => (JsonNode?)VectorJson.ToJson(t)).ToArray()),
                };
                Assert.Equal(expectedResponse, VectorJson.Canonical(response));
                return;
            }
            default:
                Assert.Fail($"unknown method {method}");
                return;
        }
    }
}
