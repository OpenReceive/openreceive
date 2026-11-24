using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>
/// spec/test-vectors/swap-provider-limits.json through the production request guard: the
/// profile numbers, the host that picks a profile (only FixedFloat's own is counted
/// locally), and every scenario step.
/// </summary>
public class SwapProviderLimitsVectors
{
    private const string Family = "swap-provider-limits.json";

    private static readonly Dictionary<string, SwapProviderLimits> Profiles = new(StringComparer.Ordinal)
    {
        [SwapProviderLimits.FixedFloatProfile] = SwapProviderLimits.FixedFloat,
        [SwapProviderLimits.ProviderOnlyProfile] = SwapProviderLimits.ProviderOnly,
    };

    public static TheoryData<string> Hosts()
    {
        var data = new TheoryData<string>();
        foreach (var host in TestVectors.Cases(Family, "hosts")) data.Add(host["base_url"]!.GetValue<string>());
        return data;
    }

    public static TheoryData<string> Scenarios() => VectorJson.Names(Family, "scenarios");

    [Fact]
    public void Profiles_carry_the_pinned_numbers()
    {
        var family = TestVectors.Load(Family);
        var expected = (JsonObject)family["profiles"]!;

        Assert.Equal(SwapProviderWeightBudget.WindowSeconds, family["window_seconds"]!.GetValue<int>());
        Assert.Equal(expected.Select(profile => profile.Key).Order(), Profiles.Keys.Order());
        foreach (var (name, limits) in Profiles)
        {
            Assert.Equal(name, limits.Profile);
            var budget = limits.LocalBudget;
            var actual = new JsonObject
            {
                ["local_budget"] = budget is null ? null : new JsonObject
                {
                    ["soft_cap"] = budget.SoftCap,
                    ["non_create_cap"] = budget.NonCreateCap,
                    ["create_weight"] = budget.CreateWeight,
                    ["default_weight"] = budget.DefaultWeight,
                },
                ["backoff_seconds"] = limits.BackoffSeconds,
                ["min_backoff_seconds"] = limits.MinBackoffSeconds,
                ["max_backoff_seconds"] = limits.MaxBackoffSeconds,
                ["create_backoff_only"] = limits.CreateBackoffOnly,
            };
            Assert.Equal(VectorJson.Canonical(expected[name]), VectorJson.Canonical(actual));
        }
    }

    [Theory]
    [MemberData(nameof(Hosts))]
    public void The_providers_host_picks_the_profile(string baseUrl)
    {
        var expected = TestVectors.Cases(Family, "hosts").Single(host => host["base_url"]!.GetValue<string>() == baseUrl)["profile"]!.GetValue<string>();

        var limits = SwapProviderLimits.ForBaseUrl(baseUrl);

        Assert.Equal(expected, limits.Profile);
        Assert.Same(Profiles[expected], limits);
        // The provider exposes what its base URL picked, and the pool builds the guard with it.
        using var client = new HttpClient(new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("{}")));
        var provider = new FixedFloatCompatibleProvider(new("vector", "key", "secret", baseUrl), client);
        Assert.Same(limits, provider.Limits);
        Assert.Same(limits, new SwapProviderWeightBudget(provider.Name, () => 0, provider.Limits).Limits);
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void Scenario_steps_run_as_pinned(string name)
    {
        var scenario = VectorJson.Case(Family, name, "scenarios");
        var steps = ((JsonArray)scenario["steps"]!).Select(step => (JsonObject)step!).ToArray();
        var now = steps[0]["at"]!.GetValue<long>();
        var budget = new SwapProviderWeightBudget("vector", () => now, Profiles[scenario["profile"]!.GetValue<string>()]);

        for (var index = 0; index < steps.Length; index += 1)
        {
            var step = steps[index];
            now = step["at"]!.GetValue<long>();
            var op = step["op"]!.GetValue<string>();
            var path = step["path"]!.GetValue<string>();
            var label = $"{name}: step {index + 1} ({op} {path} at {now})";
            for (var run = 0; run < (step["repeat"]?.GetValue<int>() ?? 1); run += 1)
            {
                if (op == "rate_limited")
                {
                    budget.MarkRateLimited(path, step["retry_after"]?.GetValue<double>());
                    continue;
                }
                var result = "ok";
                long? until = null;
                try
                {
                    switch (op)
                    {
                        case "check": budget.AssertAvailable(path); break;
                        case "reserve": budget.Reserve(path); break;
                        default: Assert.Fail($"{label}: unknown op"); break;
                    }
                }
                catch (SwapWeightBudgetException denial)
                {
                    result = denial.Reason;
                    until = denial.BackoffUntil;
                }
                Assert.True(step["expect"]!.GetValue<string>() == result, $"{label}: expected {step["expect"]}, got {result}");
                if (step["backoff_until"] is { } expectedUntil)
                {
                    Assert.True(expectedUntil.GetValue<long>() == until, $"{label}: expected the stand-off to end at {expectedUntil}, got {until}");
                }
            }
        }
    }
}
