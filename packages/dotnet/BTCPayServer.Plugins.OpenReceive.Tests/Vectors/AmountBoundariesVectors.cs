using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/amount-boundaries.json against <see cref="NwcNormalize.ValidateMakeInvoiceRequest"/> with an amount alone.</summary>
public sealed class AmountBoundariesVectors
{
    private const string File = "amount-boundaries.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Fact]
    public void BoundariesAreTheKernelBoundaries()
    {
        var msats = TestVectors.Load(File)["amount_msats"]!;
        Assert.Equal(OpenReceiveTables.MinAmountMsats, msats["minimum"]!.GetValue<long>());
        Assert.Equal(OpenReceiveTables.MaxAmountMsats, msats["maximum"]!.GetValue<long>());
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var request = new MakeInvoiceRequest { AmountMsats = c["amount_msats"]!.GetValue<long>() };

        if (c["valid"]!.GetValue<bool>())
        {
            NwcNormalize.ValidateMakeInvoiceRequest(request);
            return;
        }
        var error = Assert.Throws<NwcValidationException>(() => NwcNormalize.ValidateMakeInvoiceRequest(request));
        Assert.Equal(c["error"]!.GetValue<string>(), error.Message);
    }
}
