using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/make-invoice-validation.json against <see cref="NwcNormalize.ValidateMakeInvoiceRequest"/>.</summary>
public sealed class MakeInvoiceValidationVectors
{
    private const string File = "make-invoice-validation.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var raw = c["request"]!;
        var expected = c["expected"]!;

        var request = new MakeInvoiceRequest
        {
            AmountMsats = raw["amount_msats"]!.GetValue<long>(),
            Description = VectorJson.OptionalString(raw["description"]),
            DescriptionHash = VectorJson.OptionalString(raw["description_hash"]),
            MetadataJson = raw["metadata_note_length"] is { } length
                ? new JsonObject { ["note"] = new string('x', length.GetValue<int>()) }.ToJsonString()
                : null,
        };

        if (expected["valid"]!.GetValue<bool>())
        {
            NwcNormalize.ValidateMakeInvoiceRequest(request);
            return;
        }
        var error = Assert.Throws<NwcValidationException>(() => NwcNormalize.ValidateMakeInvoiceRequest(request));
        Assert.Equal(expected["error"]!.GetValue<string>(), error.Code);
    }
}
