using System.Net;
using System.Text;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using Microsoft.Extensions.Logging;

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

/// <summary>
/// Records every check, reserve and rate-limit mark the transport makes. With an
/// <paramref name="inner"/> guard each call is recorded first and then decided by it.
/// </summary>
public sealed class RecordingWeightBudget(ISwapWeightBudget? inner = null) : ISwapWeightBudget
{
    public List<string> Checked { get; } = new();
    public List<string> Reserved { get; } = new();
    /// <summary>The path and the provider's own wait each 429 handed over.</summary>
    public List<(string? Path, double? RetryAfterSeconds)> RateLimited { get; } = new();
    public int RateLimitedCount => RateLimited.Count;

    public void AssertAvailable(string path)
    {
        Checked.Add(path);
        inner?.AssertAvailable(path);
    }

    public void Reserve(string path)
    {
        Reserved.Add(path);
        inner?.Reserve(path);
    }

    public void MarkRateLimited(string? path = null, double? retryAfterSeconds = null)
    {
        RateLimited.Add((path, retryAfterSeconds));
        inner?.MarkRateLimited(path, retryAfterSeconds);
    }
}

/// <summary>An <see cref="ILogger{T}"/> that keeps every formatted line with its level.</summary>
public sealed class RecordingLogger<T> : ILogger<T>
{
    private readonly List<(LogLevel Level, string Line)> _entries = new();

    public IReadOnlyList<(LogLevel Level, string Line)> Entries
    {
        get { lock (_entries) return _entries.ToArray(); }
    }

    /// <summary>The lines of one event (a line starts with its event name).</summary>
    public IReadOnlyList<string> Event(string name) =>
        Entries.Where(entry => entry.Line.StartsWith(name + " ", StringComparison.Ordinal)).Select(entry => entry.Line).ToArray();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        lock (_entries) _entries.Add((logLevel, formatter(state, exception)));
    }
}
