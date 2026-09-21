#nullable enable
using System;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>Credential projection at public-error and host diagnostic boundaries.</summary>
public static class SecretSafeDiagnostics
{
    private static readonly Regex Connections = new(@"(?:nostr\+walletconnect|lightning\+swapconnect):[^\s\""'<>]+", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex QuerySecrets = new(@"([?&](?:secret|token|provider_token|api_key|key)=)[^&\s\""'<>]*", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly string[] Sensitive = { "token", "providertoken", "apikey", "secret", "nwc", "nwcuri", "lsc", "lscuri", "swapdata", "invoice", "bolt11", "preimage", "authorization", "password" };

    public static string Text(string text) => QuerySecrets.Replace(Connections.Replace(text, m =>
        m.Value.StartsWith("nostr+", StringComparison.OrdinalIgnoreCase) ? "[REDACTED_NWC]" : "[REDACTED_LSC]"), "$1[REDACTED]");

    public static JsonNode? Project(JsonNode? value)
    {
        if (value is JsonObject obj)
        {
            var result = new JsonObject();
            foreach (var (key, item) in obj)
            {
                var normalized = key.Replace("_", "").Replace("-", "").ToLowerInvariant();
                result[key] = Sensitive.Contains(normalized) ? JsonValue.Create("[REDACTED]") : Project(item);
            }
            return result;
        }
        if (value is JsonArray array) return new JsonArray(array.Select(Project).ToArray());
        if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text)) return JsonValue.Create(Text(text));
        return value?.DeepClone();
    }
}
