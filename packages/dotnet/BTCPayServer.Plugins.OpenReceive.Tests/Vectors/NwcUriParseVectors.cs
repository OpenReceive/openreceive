using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/nwc-uri-parse.json against <see cref="NwcUri.Parse"/>.</summary>
public sealed class NwcUriParseVectors
{
    private const string File = "nwc-uri-parse.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var uri = c["uri"]!.GetValue<string>();

        if (c["expected_error"] is { } expectedError)
        {
            var error = Assert.Throws<NwcUriParseException>(() => NwcUri.Parse(uri));
            Assert.Equal(expectedError.GetValue<string>(), error.Code);
            Assert.Equal(NwcUri.Redact(uri), error.Redacted);
            return;
        }

        var expected = c["expected"]!;
        var parsed = NwcUri.Parse(uri);
        Assert.Equal(expected["wallet_pubkey"]!.GetValue<string>(), parsed.WalletPubkey);
        Assert.Equal(VectorJson.Strings(expected["relays"]), parsed.RelayUrls);
        Assert.Equal(VectorJson.Strings(expected["relays"]), parsed.Relays.Select(r => r.OriginalString));
        Assert.Equal(expected["secret_present"]!.GetValue<bool>(), parsed.Secret.Length == 64);
        Assert.Equal(VectorJson.OptionalString(expected["lud16"]), parsed.Lud16);
        Assert.Equal(expected["redacted"]!.GetValue<string>(), parsed.Redacted);
        Assert.Equal(parsed.Redacted, NwcUri.Redact(uri));
        Assert.DoesNotContain(parsed.Secret, parsed.Redacted);
    }
}
