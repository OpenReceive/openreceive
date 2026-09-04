using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/nwc-info.json against <see cref="NwcInfo.Summarize"/>: raw_info is passed as the governing info.</summary>
public sealed class NwcInfoVectors
{
    private const string File = "nwc-info.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var expected = c["expected"]!;

        var summary = NwcInfo.Summarize(VectorJson.Connection(), c["raw_info"]);

        Assert.Equal(VectorJson.Strings(expected["methods"]), summary.Methods);
        Assert.Equal(VectorJson.OptionalString(expected["encryption"]), summary.Encryption);
        Assert.Equal(expected["spend_capability_advertised"]!.GetValue<bool>(), summary.SpendCapabilityAdvertised);
        Assert.Equal(expected["receive_checkout_ready"]!.GetValue<bool>(), summary.ReceiveCheckoutReady);
        Assert.Equal(VectorJson.Strings(expected["warning_methods"]), summary.SpendMethods);
        Assert.Equal(summary.SpendMethods.Count, summary.Warnings.Count);
        Assert.Equal(!summary.ReceiveCheckoutReady, summary.MissingMethods.Count > 0);
    }
}
