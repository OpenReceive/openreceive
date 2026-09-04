using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/lsc-uri.json through the production LSC URI parser.</summary>
public class LscUriVectors
{
    private const string Family = "lsc-uri.json";

    public static TheoryData<string> ValidCases() => Names("valid");
    public static TheoryData<string> InvalidCases() => Names("invalid");

    [Theory]
    [MemberData(nameof(ValidCases))]
    public void Valid_uri_parses_to_the_expected_connection(string name)
    {
        var testCase = Case("valid", name);
        var expected = (JsonObject)testCase["expected"]!;

        var connection = LscUri.Parse(testCase["uri"]!.GetValue<string>());

        Assert.Equal(LscUri.Protocol, expected["uri_protocol"]!.GetValue<string>());
        Assert.Equal(expected["base_url"]!.GetValue<string>(), connection.BaseUrl);
        Assert.Equal(expected["provider_id"]!.GetValue<string>(), connection.ProviderId);
        Assert.Equal(expected["key"]!.GetValue<string>(), connection.Key);
        Assert.Equal(expected["secret"]!.GetValue<string>(), connection.Secret);
    }

    [Theory]
    [MemberData(nameof(InvalidCases))]
    public void Invalid_uri_is_refused_without_leaking_credentials(string name)
    {
        var uri = Case("invalid", name)["uri"]!.GetValue<string>();

        var error = Assert.Throws<FormatException>(() => LscUri.Parse(uri));

        Assert.DoesNotContain("secret=", error.Message);
        Assert.False(LscUri.TryParse(uri, out var connection, out var message));
        Assert.Null(connection);
        Assert.Equal(error.Message, message);
    }

    [Fact]
    public void Format_round_trips_through_parse()
    {
        var uri = LscUri.Format("https://swap.example/v1", "key+one", "secret/two");

        Assert.Equal("lightning+swapconnect://swap.example/v1/?key=key%2Bone&secret=secret%2Ftwo", uri);
        var connection = LscUri.Parse(uri);
        Assert.Equal("https://swap.example/v1/", connection.BaseUrl);
        Assert.Equal("swap-example-v1", connection.ProviderId);
        Assert.Equal("key+one", connection.Key);
        Assert.Equal("secret/two", connection.Secret);
    }

    [Fact]
    public void Port_is_part_of_the_base_url_and_provider_id()
    {
        var connection = LscUri.Parse("lightning+swapconnect://ff.example:8443/api?key=k&secret=s");

        Assert.Equal("https://ff.example:8443/api/", connection.BaseUrl);
        Assert.Equal("ff-example-8443-api", connection.ProviderId);
    }

    private static TheoryData<string> Names(string key)
    {
        var data = new TheoryData<string>();
        foreach (var testCase in TestVectors.Cases(Family, key))
        {
            data.Add(testCase["name"]!.GetValue<string>());
        }
        return data;
    }

    private static JsonObject Case(string key, string name) =>
        TestVectors.Cases(Family, key).Single(testCase => testCase["name"]!.GetValue<string>() == name);
}
