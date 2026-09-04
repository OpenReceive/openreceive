using System.Net;
using System.Text;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

/// <summary>One request the fake provider saw: the message plus its body bytes.</summary>
public sealed record CapturedRequest(HttpRequestMessage Message, byte[] Body)
{
    public string BodyText => Encoding.UTF8.GetString(Body);
    public string Path => Message.RequestUri!.AbsolutePath;
}

/// <summary>An in-memory HttpMessageHandler standing in for a FixedFloat-compatible API.</summary>
public sealed class FakeSwapProviderHandler : HttpMessageHandler
{
    private readonly Func<CapturedRequest, CancellationToken, Task<HttpResponseMessage>> _respond;

    public List<CapturedRequest> Requests { get; } = new();

    public FakeSwapProviderHandler(Func<CapturedRequest, CancellationToken, Task<HttpResponseMessage>> respond)
    {
        _respond = respond;
    }

    public FakeSwapProviderHandler(Func<CapturedRequest, HttpResponseMessage> respond)
        : this((request, _) => Task.FromResult(respond(request)))
    {
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null
            ? Array.Empty<byte>()
            : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        var captured = new CapturedRequest(request, body);
        Requests.Add(captured);
        return await _respond(captured, cancellationToken);
    }

    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Text(string text, string mediaType, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(text, Encoding.UTF8, mediaType) };
}

/// <summary>Records every reserve and rate-limit mark the transport makes.</summary>
public sealed class RecordingWeightBudget : ISwapWeightBudget
{
    public List<string> Reserved { get; } = new();
    public int RateLimitedCount { get; private set; }

    public void Reserve(string path) => Reserved.Add(path);
    public void MarkRateLimited() => RateLimitedCount += 1;
}
