using System.Net;
using System.Text;

namespace OpenReceive.FakeLsc;

/// <summary>
/// Routes <see cref="HttpRequestMessage"/>s straight into a <see cref="FakeLscProviderCore"/>
/// so a FixedFloat-compatible client can run in-process over
/// <c>new HttpClient(handler) { BaseAddress = ... }</c> with no Kestrel. Any host name is accepted.
/// </summary>
public sealed class FakeLscHttpMessageHandler(FakeLscProviderCore core) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in request.Headers) headers[name] = string.Join(",", values);
        if (request.Content is not null)
        {
            foreach (var (name, values) in request.Content.Headers) headers[name] = string.Join(",", values);
        }
        var body = request.Content is null
            ? ""
            : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var pathAndQuery = request.RequestUri?.PathAndQuery ?? "/";

        var response = await core.HandleAsync(request.Method.Method, pathAndQuery, headers, body, cancellationToken).ConfigureAwait(false);
        var mediaType = response.ContentType.Split(';', 2)[0].Trim();
        return new HttpResponseMessage((HttpStatusCode)response.Status)
        {
            RequestMessage = request,
            Content = new StringContent(response.Body, Encoding.UTF8, mediaType),
        };
    }
}
