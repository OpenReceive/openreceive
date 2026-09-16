using BTCPayServer.Plugins.OpenReceive.Settings;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Settings;

/// <summary>
/// The Lightning-node description shown to <c>CanViewStoreSettings</c> callers (the
/// Greenfield settings route and the doctor page). BTCPay accepts <c>lndhub://login:password@…</c>
/// verbatim and key=value fields in any order, so a raw field of a foreign string can be a
/// credential: the description is only ever a backend type word, or our own string redacted.
/// </summary>
public sealed class LightningNodeDescriptionTests
{
    private const string Pubkey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Secret = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string NwcUriText = "nostr+walletconnect://" + Pubkey + "?relay=wss%3A%2F%2Frelay.example.com&secret=" + Secret;

    private static readonly string[] Secrets = { "s3cret", "abcdef", Secret };

    private static string DescribeWithoutSecrets(string connectionString)
    {
        var described = OpenReceiveSettingsService.Describe(connectionString);
        foreach (var secret in Secrets)
        {
            Assert.DoesNotContain(secret, described);
        }
        return described;
    }

    [Theory]
    [InlineData("lndhub://login:s3cret@https://lndhub.io", "lndhub")]
    [InlineData("LNDHUB://login:s3cret@https://lndhub.io", "lndhub")]
    [InlineData("server=https://user:s3cret@host;type=lndhub", "lndhub")]
    [InlineData("type=eclair;server=https://h;password=s3cret", "eclair")]
    [InlineData("type=lnd-rest;server=https://h;macaroon=abcdef", "lnd-rest")]
    [InlineData(" type = LND-REST ;server=https://h;macaroon=abcdef", "lnd-rest")]
    [InlineData("type=clightning;server=tcp://user:s3cret@h", "clightning")]
    [InlineData("type=nwc;key=" + NwcUriText, "nwc")]
    [InlineData("server=https://user:s3cret@host", "Other Lightning backend")]
    [InlineData("type=;server=https://user:s3cret@host", "Other Lightning backend")]
    [InlineData("garbage", "Other Lightning backend")]
    [InlineData("s3cret", "Other Lightning backend")]
    [InlineData("", "Other Lightning backend")]
    public void Foreign_strings_describe_as_a_type_word_only(string connectionString, string expected)
    {
        Assert.Equal(expected, DescribeWithoutSecrets(connectionString));
    }

    [Theory]
    [InlineData("type=openreceive;nwc=" + NwcUriText)]
    [InlineData("type=openreceive;nwc=" + NwcUriText + ";allow-spend=true")]
    public void Our_string_describes_as_its_redacted_canonical_form(string connectionString)
    {
        var described = DescribeWithoutSecrets(connectionString);
        Assert.StartsWith("type=openreceive;nwc=nostr+walletconnect://" + Pubkey, described);
        Assert.Contains("secret=[REDACTED]", described);
        Assert.Equal(connectionString.EndsWith(";allow-spend=true", StringComparison.Ordinal), described.EndsWith(";allow-spend=true", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("type=openreceive;bogus=1")]
    [InlineData("type=openreceive")]
    [InlineData("type=openreceive;nwc=")]
    [InlineData("type=openreceive;nwc=" + NwcUriText + ";nwc=" + NwcUriText)]
    [InlineData("type=openreceive;nwc=" + NwcUriText + ";password=s3cret")]
    public void A_malformed_string_of_ours_describes_as_openreceive_without_throwing(string connectionString)
    {
        Assert.Equal("openreceive", DescribeWithoutSecrets(connectionString));
    }
}
