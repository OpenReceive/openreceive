using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

/// <summary>Provider amounts that arrive as JSON numbers must read as plain decimal text, never exponent notation.</summary>
public sealed class FixedFloatFieldsTests
{
    [Theory]
    [InlineData("0.00000001", "0.00000001")]
    [InlineData("1e-8", "0.00000001")]
    [InlineData("2.5E-7", "0.00000025")]
    [InlineData("10.10", "10.10")]
    [InlineData("12345678901234567890", "12345678901234567890")]
    public void A_json_number_is_rendered_as_plain_decimal_text(string json, string expected)
    {
        var node = JsonNode.Parse($"{{\"amount\":{json}}}")!.AsObject();

        var text = FixedFloatFields.OptionalStringField(node, "amount");

        Assert.Equal(expected, text);
        Assert.Equal(text, FixedFloatFields.ReadDecimalAmountString(text, "amount")); // the amount check accepts it
    }
}
