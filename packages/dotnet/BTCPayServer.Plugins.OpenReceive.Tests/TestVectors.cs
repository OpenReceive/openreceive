using System.Text.Json;
using System.Text.Json.Nodes;

namespace BTCPayServer.Plugins.OpenReceive.Tests;

/// <summary>
/// Loads spec/test-vectors/&lt;family&gt;.json from the repository, wherever the test
/// binary runs from. Every vector class names its family with the literal
/// "&lt;family&gt;.json" so spec/test-vectors/coverage.json can see the consumer.
/// </summary>
public static class TestVectors
{
    private static readonly Lazy<string> RepoRoot = new(FindRepoRoot);

    public static string Root => RepoRoot.Value;

    public static string PathFor(string fileName) => Path.Combine(Root, "spec", "test-vectors", fileName);

    public static JsonNode Load(string fileName)
    {
        var text = File.ReadAllText(PathFor(fileName));
        return JsonNode.Parse(text) ?? throw new InvalidOperationException($"{fileName} is empty");
    }

    public static IEnumerable<JsonObject> Cases(string fileName, string key = "cases")
    {
        var node = Load(fileName);
        var cases = node[key] as JsonArray ?? throw new InvalidOperationException($"{fileName} has no '{key}' array");
        foreach (var item in cases)
        {
            yield return item as JsonObject ?? throw new InvalidOperationException($"{fileName}: non-object case");
        }
    }

    public static string Json(JsonNode? node) =>
        node is null ? "null" : node.ToJsonString(new JsonSerializerOptions { WriteIndented = false });

    private static string FindRepoRoot()
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dir = new DirectoryInfo(start);
            while (dir is not null)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "spec", "test-vectors")) &&
                    File.Exists(Path.Combine(dir.FullName, "package.json")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
        }
        throw new InvalidOperationException("Could not locate the OpenReceive repository root (spec/test-vectors) above the test binary.");
    }
}
