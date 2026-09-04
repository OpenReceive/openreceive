using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>
/// spec/test-vectors/attempt-reconciliation.json against <see cref="WalletScan.LightningStatusFor"/>.
/// The vector's decision table (expired / attention / keep waiting) is the JS and Ruby engines'
/// closure rule. In the BTCPay plugin closure is BTCPay's decision: it owns invoice expiry and
/// stops watching a hash the moment a listener says Expired, so the plugin only ever forwards
/// the wallet's OWN verdict (failed / expired → Expired, settled → Paid) and reports everything
/// else — not_found and pending alike, even past expiry plus grace — as Unpaid.
/// </summary>
public sealed class AttemptReconciliationVectors
{
    private const string File = "attempt-reconciliation.json";

    public static TheoryData<string> Names => VectorJson.Names(File, "vectors");

    [Fact]
    public void GraceIsTheKernelGrace()
    {
        Assert.Equal(OpenReceiveTables.AttemptExpiryGraceSeconds, TestVectors.Load(File)["expiry_grace_seconds"]!.GetValue<int>());
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var v = VectorJson.Case(File, name, "vectors");
        var status = v["status"]!.GetValue<string>();
        var observedAt = v["observed_at"]!.GetValue<long>();
        var expiresAt = v["attempt"]!["expires_at"]!.GetValue<long>();
        var transaction = status == "not_found" ? null : new NwcTransaction
        {
            PaymentHash = new string('1', 64),
            ExpiresAt = expiresAt,
            TransactionState = VectorJson.OptionalString(v["transaction_state"]),
        };
        var check = new PaymentCheck(new string('1', 64), status, null, transaction, observedAt);

        // Paid attempts never reach this decision table.
        Assert.NotEqual("settled", status);

        var lightningStatus = WalletScan.LightningStatusFor(check);
        if (status is "failed" or "expired")
        {
            Assert.Equal("Expired", lightningStatus);
        }
        else
        {
            // Even at observed_at >= expires_at + grace: closing on time is BTCPay's call.
            Assert.Equal("Unpaid", lightningStatus);
        }
        if (observedAt >= expiresAt + OpenReceiveTables.AttemptExpiryGraceSeconds && status is "not_found" or "pending")
        {
            Assert.Equal("Unpaid", lightningStatus);
        }
    }
}
