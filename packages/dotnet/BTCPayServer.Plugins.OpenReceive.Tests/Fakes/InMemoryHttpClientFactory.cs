namespace BTCPayServer.Plugins.OpenReceive.Tests.Fakes;

/// <summary>
/// An <see cref="IHttpClientFactory"/> whose every client routes into one in-memory
/// <see cref="HttpMessageHandler"/> (the fake LSC provider) under a fixed base address.
/// </summary>
public sealed class InMemoryHttpClientFactory : IHttpClientFactory
{
    public const string BaseAddress = "https://fake-lsc.test/";

    private readonly HttpMessageHandler _handler;

    public InMemoryHttpClientFactory(HttpMessageHandler handler)
    {
        _handler = handler;
    }

    public List<string> CreatedClientNames { get; } = new();

    public HttpClient CreateClient(string name)
    {
        CreatedClientNames.Add(name);
        return new HttpClient(_handler, disposeHandler: false) { BaseAddress = new Uri(BaseAddress) };
    }
}
