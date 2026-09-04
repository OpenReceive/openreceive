using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/error-normalization.json against <see cref="NwcErrors.Normalize(System.Text.Json.Nodes.JsonNode)"/>.</summary>
public sealed class ErrorNormalizationVectors
{
    private const string File = "error-normalization.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var expected = c["expected"]!;

        var error = NwcErrors.Normalize(c["raw_error"]!);

        Assert.Equal(expected["code"]!.GetValue<string>(), error.Code);
        Assert.Equal(expected["message"]!.GetValue<string>(), error.Message);
        Assert.Equal(expected["retryable"]!.GetValue<bool>(), error.Retryable);
        Assert.Equal(VectorJson.OptionalString(expected["request_id"]), error.RequestId);
    }
}
