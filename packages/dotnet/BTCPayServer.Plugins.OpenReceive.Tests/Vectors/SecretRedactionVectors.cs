using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

public sealed class SecretRedactionVectors
{
    public static TheoryData<string> Names => VectorJson.Names("secret-redaction.json", "vectors");
    [Theory]
    [MemberData(nameof(Names))]
    public void Case(string name)
    {
        var item = VectorJson.Case("secret-redaction.json", name, "vectors");
        Assert.Equal(VectorJson.Canonical(item["expected"]), VectorJson.Canonical(SecretSafeDiagnostics.Project(item["input"])));
    }
}
