#nullable enable
using System;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

public enum FixedFloatApiErrorKind
{
    /// <summary>The envelope answered with a non-zero <c>code</c>.</summary>
    Api,
    /// <summary>A non-2xx HTTP status other than 429.</summary>
    Http,
    /// <summary>The body was not JSON.</summary>
    InvalidJson,
    /// <summary>No response was received.</summary>
    Network,
    /// <summary>HTTP 429.</summary>
    RateLimited,
    /// <summary>The request timed out.</summary>
    Timeout,
}

/// <summary>A FixedFloat-compatible API call that did not return usable data.</summary>
public sealed class FixedFloatApiException : Exception
{
    public string Path { get; }
    public FixedFloatApiErrorKind Kind { get; }
    public int? Status { get; }
    public string? FixedFloatCode { get; }
    public string? FixedFloatMessage { get; }

    public FixedFloatApiException(
        string path,
        FixedFloatApiErrorKind kind,
        string message,
        int? status = null,
        string? fixedFloatCode = null,
        string? fixedFloatMessage = null,
        Exception? cause = null)
        : base(message, cause)
    {
        Path = path;
        Kind = kind;
        Status = status;
        FixedFloatCode = fixedFloatCode;
        FixedFloatMessage = fixedFloatMessage;
    }
}

/// <summary>
/// Everything that crosses the wire to a FixedFloat-compatible API: the HMAC-signed
/// <c>/api/v2</c> POST, envelope parsing into data or <see cref="FixedFloatApiException"/>,
/// request/response log surfacing, weight-budget reserve / 429 accounting, and the
/// unauthenticated GET for the public XML rates export.
/// </summary>
public sealed class FixedFloatTransport
{
    private static readonly JsonSerializerOptions BodyJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Already stripped of trailing slashes; also the origin of the XML rates GET.</summary>
    public string BaseUrl { get; }
    public TimeSpan RequestTimeout { get; }

    private readonly HttpClient _httpClient;
    private readonly string _provider;
    private readonly string _key;
    private readonly byte[] _secret;
    private Action<SwapProviderApiRequestLog>? _apiRequestLogger;
    private Action<SwapProviderApiResponseLog>? _apiResponseLogger;
    private ISwapWeightBudget? _weightBudget;

    public FixedFloatTransport(HttpClient httpClient, string key, string secret, string baseUrl, string provider, TimeSpan requestTimeout)
    {
        _httpClient = httpClient;
        _key = key;
        _secret = Encoding.UTF8.GetBytes(secret);
        BaseUrl = baseUrl.TrimEnd('/');
        _provider = provider;
        RequestTimeout = requestTimeout;
    }

    public void AttachApiRequestLogger(Action<SwapProviderApiRequestLog> log) => _apiRequestLogger = log;
    public void AttachApiResponseLogger(Action<SwapProviderApiResponseLog> log) => _apiResponseLogger = log;
    public void AttachWeightBudget(ISwapWeightBudget budget) => _weightBudget = budget;

    /// <summary>POST <c>{baseUrl}/api/v2/{path}</c> and return the envelope's <c>data</c>.</summary>
    public async Task<JsonNode?> PostAsync(string path, JsonObject body, CancellationToken cancellationToken)
    {
        _weightBudget?.Reserve(path);
        var bodyString = body.ToJsonString(BodyJsonOptions);
        var bodyBytes = Encoding.UTF8.GetBytes(bodyString);
        // Surface every outbound request before the call. The API key and HMAC
        // signature live in headers and are deliberately never logged; the order
        // token (status/refund bodies) is redacted before the entry leaves here.
        LogApiRequest(path, RedactedBodyJson(body));

        HttpResponseMessage response;
        string text;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{BaseUrl}/api/v2/{path}");
            request.Content = new ByteArrayContent(bodyBytes);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "UTF-8" };
            request.Headers.TryAddWithoutValidation("X-API-KEY", _key);
            request.Headers.TryAddWithoutValidation("X-API-SIGN", Sign(bodyBytes));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token).ConfigureAwait(false);
            text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            var apiError = FromTransportError(path, error);
            LogApiResponse(path, 0, false, null, apiError.Message);
            throw apiError;
        }

        using (response)
        {
            var status = (int)response.StatusCode;
            JsonObject envelope;
            try
            {
                envelope = text.Length == 0 ? new JsonObject() : FixedFloatFields.ObjectOrEmpty(JsonNode.Parse(text));
            }
            catch (JsonException error)
            {
                var message = $"FixedFloat {path} returned invalid JSON.";
                LogApiResponse(path, status, false, null, message);
                throw new FixedFloatApiException(path, FixedFloatApiErrorKind.InvalidJson, message, status, cause: error);
            }
            var code = envelope["code"];
            var msg = envelope["msg"];
            var codeText = FixedFloatFields.OptionalCoercedString(code) ?? (code is null ? null : code.ToJsonString());
            var msgText = FixedFloatFields.OptionalCoercedString(msg);
            LogApiResponse(path, status, response.IsSuccessStatusCode, codeText, msgText);
            if (!response.IsSuccessStatusCode)
            {
                var rateLimited = response.StatusCode == HttpStatusCode.TooManyRequests;
                if (rateLimited) _weightBudget?.MarkRateLimited();
                throw new FixedFloatApiException(
                    path,
                    rateLimited ? FixedFloatApiErrorKind.RateLimited : FixedFloatApiErrorKind.Http,
                    msgText is null
                        ? $"FixedFloat {path} failed with HTTP {status}."
                        : $"FixedFloat {path} failed with HTTP {status}: {msgText}",
                    status,
                    fixedFloatMessage: msgText);
            }
            if (!IsZero(code))
            {
                throw new FixedFloatApiException(
                    path,
                    FixedFloatApiErrorKind.Api,
                    msg is JsonValue && msg.GetValueKind() == JsonValueKind.String ? msg.GetValue<string>() : $"FixedFloat {path} failed.",
                    fixedFloatCode: codeText,
                    fixedFloatMessage: msgText);
            }
            return envelope["data"];
        }
    }

    /// <summary>GET <c>{baseUrl}{absolutePath}</c> as text (the public XML rates export).</summary>
    public async Task<string> GetTextAsync(string absolutePath, CancellationToken cancellationToken)
    {
        var name = absolutePath[(absolutePath.LastIndexOf('/') + 1)..];
        HttpResponseMessage response;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{BaseUrl}{absolutePath}");
            request.Headers.TryAddWithoutValidation("Accept", "application/xml, text/xml, */*");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token).ConfigureAwait(false);
            using (response)
            {
                if (!response.IsSuccessStatusCode)
                {
                    throw new InvalidOperationException($"FixedFloat rates {name} failed with HTTP {(int)response.StatusCode}.");
                }
                return await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            }
        }
        catch (Exception error) when (error is not InvalidOperationException &&
                                      (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested))
        {
            var timedOut = IsTimeout(error);
            throw new InvalidOperationException(
                timedOut
                    ? $"FixedFloat rates {name} request timed out."
                    : $"FixedFloat rates {name} request failed before a response was received.",
                error);
        }
    }

    public void LogApiRequest(string path, string? bodyJson = null) =>
        _apiRequestLogger?.Invoke(new SwapProviderApiRequestLog(_provider, path, bodyJson));

    public void LogApiResponse(string path, int status, bool ok, string? code, string? message) =>
        _apiResponseLogger?.Invoke(new SwapProviderApiResponseLog(_provider, path, status, ok, code, message));

    private static string RedactedBodyJson(JsonObject body)
    {
        if (!body.ContainsKey("token")) return body.ToJsonString(BodyJsonOptions);
        var redacted = (JsonObject)body.DeepClone();
        redacted["token"] = "[redacted]";
        return redacted.ToJsonString(BodyJsonOptions);
    }

    private string Sign(byte[] bodyBytes) =>
        Convert.ToHexString(HMACSHA256.HashData(_secret, bodyBytes)).ToLowerInvariant();

    private static bool IsZero(JsonNode? code)
    {
        if (code is not JsonValue value) return false;
        if (value.TryGetValue<JsonElement>(out var element))
        {
            return element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out var real) && real == 0;
        }
        if (value.TryGetValue<int>(out var i)) return i == 0;
        if (value.TryGetValue<long>(out var l)) return l == 0;
        if (value.TryGetValue<double>(out var d)) return d == 0;
        if (value.TryGetValue<decimal>(out var m)) return m == 0;
        return false;
    }

    private static bool IsTimeout(Exception error) =>
        error is OperationCanceledException ||
        error is TimeoutException ||
        error.InnerException is TimeoutException;

    private static FixedFloatApiException FromTransportError(string path, Exception error)
    {
        var timedOut = IsTimeout(error);
        return new FixedFloatApiException(
            path,
            timedOut ? FixedFloatApiErrorKind.Timeout : FixedFloatApiErrorKind.Network,
            timedOut
                ? $"FixedFloat {path} request timed out."
                : $"FixedFloat {path} request failed before a response was received.",
            cause: error);
    }
}
