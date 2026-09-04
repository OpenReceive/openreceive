using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/swap-state.json through the production FixedFloat status normalizer.</summary>
public class SwapStateVectors
{
    private const string Family = "swap-state.json";

    public static TheoryData<string> Cases()
    {
        var data = new TheoryData<string>();
        foreach (var testCase in TestVectors.Cases(Family))
        {
            data.Add(testCase["name"]!.GetValue<string>());
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Status_normalizes_to_the_pinned_state_and_reasons(string name)
    {
        var testCase = TestVectors.Cases(Family).Single(item => item["name"]!.GetValue<string>() == name);
        var status = testCase["status"]!.GetValue<string>();
        var emergency = testCase["emergency"] as JsonObject;
        var refundTxId = testCase["refund_tx_present"]!.GetValue<bool>() ? "tx" : null;
        var expected = (JsonObject)testCase["expected"]!;

        var result = FixedFloatOrders.NormalizeStatus(status, emergency, refundTxId);

        Assert.Equal(expected["state"]!.GetValue<string>(), result.State);
        Assert.Equal(expected["attention"]?.GetValue<bool>(), result.Attention);
        Assert.Equal(expected["attention_reason"]?.GetValue<string>(), result.AttentionReason);
        Assert.Equal(expected["refund_reason"]?.GetValue<string>(), result.RefundReason);
        Assert.Contains(result.State, OpenReceiveTables.SwapProviderStates);
        if (result.AttentionReason is not null)
        {
            Assert.Contains(result.AttentionReason, OpenReceiveTables.SwapAttentionReasons);
        }
        if (result.RefundReason is not null)
        {
            Assert.Contains(result.RefundReason, OpenReceiveTables.SwapRefundReasons);
        }
    }

    [Fact]
    public void Every_provider_state_has_payer_facing_copy()
    {
        foreach (var state in OpenReceiveTables.SwapProviderStates)
        {
            var info = SwapStateCopy.For(state);
            Assert.Equal(state, info.State);
            Assert.NotEmpty(info.Label);
            Assert.NotEmpty(info.Detail);
            Assert.Equal(OpenReceiveTables.SwapStates[state].Phase, info.Phase);
            Assert.Equal(OpenReceiveTables.SwapStates[state].Terminal, info.Terminal);
        }
        Assert.False(SwapStateCopy.For("completed").Terminal);
        Assert.Equal("settling", SwapStateCopy.For("completed").Phase);
        Assert.Equal("Waiting for your payment", SwapStateCopy.For("awaiting_deposit").Label);
    }
}
