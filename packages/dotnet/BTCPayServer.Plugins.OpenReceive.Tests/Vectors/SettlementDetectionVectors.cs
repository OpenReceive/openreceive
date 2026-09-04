using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/settlement-detection.json against <see cref="Settlement.Classify"/> over normalized rows.</summary>
public sealed class SettlementDetectionVectors
{
    private const string File = "settlement-detection.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var expected = c["expected"]!;

        var transaction = NwcNormalize.Transaction(c["transaction"]);
        var detection = Settlement.Classify(transaction);

        Assert.Equal(expected["settled"]!.GetValue<bool>(), detection.Settled);
        Assert.Equal(expected["status"]!.GetValue<string>(), detection.Status);
        Assert.Equal(detection.Settled, Settlement.IsSettled(transaction));
        Assert.Equal(detection.Settled, detection.FinalitySignal is not null);
    }
}
