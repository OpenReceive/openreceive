using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

public class SwapWeightBudgetTests
{
    [Fact]
    public void Create_costs_fifty_against_a_gate_of_one_hundred_fifty()
    {
        var budget = new SwapProviderWeightBudget("ff", () => 1_000);

        budget.Reserve("create");
        budget.Reserve("create");
        budget.Reserve("create");
        var error = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create"));

        Assert.Equal("ff", error.Provider);
        Assert.Equal("create", error.Path);
        Assert.Equal(SwapProviderWeightBudget.ReasonExhausted, error.Reason);
        Assert.Equal(150, error.Used);
        Assert.Equal(50, error.Cost);
        Assert.Equal(150, error.Gate);
        Assert.Equal(1_000, error.WindowStart);
        Assert.Null(error.BackoffUntil);
        Assert.Equal("Swap provider API weight budget exhausted (150+50 > 150).", error.Message);
    }

    [Fact]
    public void Other_paths_cost_one_against_the_soft_cap_of_two_hundred()
    {
        var budget = new SwapProviderWeightBudget("ff", () => 1_000);
        for (var i = 0; i < 3; i += 1) budget.Reserve("create");

        for (var i = 0; i < 50; i += 1) budget.Reserve("order");
        var error = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("price"));

        Assert.Equal(200, error.Used);
        Assert.Equal(1, error.Cost);
        Assert.Equal(200, error.Gate);
        Assert.Equal("Swap provider API weight budget exhausted (200+1 > 200).", error.Message);
        // The create gate sits below the soft cap: the budget is not exhausted for
        // status polls just because creates are gated.
        Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create"));
    }

    [Fact]
    public void Window_rolls_after_sixty_seconds()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("ff", () => clock);
        for (var i = 0; i < 200; i += 1) budget.Reserve("order");
        Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));

        clock = 1_059;
        Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));

        clock = 1_060;
        budget.Reserve("order");
        budget.Reserve("create");
    }

    [Fact]
    public void Backoff_expires_on_its_own_clock_not_the_window()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("ff", () => clock);

        clock = 1_059;
        budget.MarkRateLimited();

        clock = 1_060; // the window it started in would roll here, the backoff must not end with it
        var error = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));
        Assert.Equal(SwapProviderWeightBudget.ReasonBackoff, error.Reason);
        Assert.Equal(1_119, error.BackoffUntil);
        Assert.Equal(1_119, error.WindowStart); // the next window starts when the stand-off ends
        Assert.Equal("Swap provider API is in backoff until 1119.", error.Message);

        clock = 1_118;
        Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));

        clock = 1_119;
        budget.Reserve("order");
    }

    [Fact]
    public void A_429_restarts_the_window_when_the_stand_off_ends()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("ff", () => clock);
        for (var i = 0; i < 200; i += 1) budget.Reserve("order"); // the window is spent

        clock = 1_030;
        budget.MarkRateLimited();

        clock = 1_059;
        var error = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));
        Assert.Equal(SwapProviderWeightBudget.ReasonBackoff, error.Reason);
        Assert.Equal(0, error.Used);
        Assert.Equal(1_090, error.BackoffUntil);
        Assert.Equal(1_090, error.WindowStart);
        Assert.Equal(1_090, error.RetryAt);

        clock = 1_090; // stand-off over: a fresh window, not the spent one
        for (var i = 0; i < 200; i += 1) budget.Reserve("order");
        var spent = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));
        Assert.Equal(SwapProviderWeightBudget.ReasonExhausted, spent.Reason);
        Assert.Equal(1_150, spent.RetryAt); // an exhausted window is tried again when it rolls
    }

    // ---- Provider limits: the guard is sized by who the provider is ----

    [Fact]
    public void A_guard_with_no_limits_gets_the_FixedFloat_ones()
    {
        Assert.Same(SwapProviderLimits.FixedFloat, new SwapProviderWeightBudget("custom", () => 1_000).Limits);
        Assert.Same(SwapProviderLimits.LightningSwap, new SwapProviderWeightBudget("ls", () => 1_000, SwapProviderLimits.LightningSwap).Limits);
    }

    /// <summary>A custom provider that implements only what <see cref="ISwapProvider"/> requires.</summary>
    private sealed class BareProvider : ISwapProvider
    {
        public string Name => "custom";
        public int InvoiceExpirySeconds => 1_800;
        public void AttachSwapCache(TransientSwapCache cache) { }
        public void AttachWeightBudget(ISwapWeightBudget budget) { }
        public void AttachApiRequestLogger(Action<SwapProviderApiRequestLog> log) { }
        public void AttachApiResponseLogger(Action<SwapProviderApiResponseLog> log) { }
        public Task<IReadOnlySet<string>> SupportedPayInAssetsAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<IReadOnlyList<SwapProviderAsset>> PayInAssetCatalogAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<SwapQuote> QuoteAsync(SwapQuoteInput input, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<SwapOrder> CreateSwapAsync(CreateSwapInput input, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<SwapOrder> GetStatusAsync(SwapOrder order, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task RequestRefundAsync(SwapOrder order, string refundAddress, CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    [Fact]
    public void A_provider_that_names_no_limits_gets_the_FixedFloat_ones_and_is_not_asked()
    {
        ISwapProvider provider = new BareProvider();

        Assert.Null(provider.Limits);
        Assert.Same(SwapProviderLimits.FixedFloat, new SwapProviderWeightBudget(provider.Name, () => 1_000, provider.Limits).Limits);
        provider.AssertCreateAvailable(); // a provider without the check is simply not asked
    }

    [Fact]
    public void A_Lightning_Swap_guard_allows_thirty_creates_a_minute_and_keeps_status_calls_going()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("lightning-swap-com", () => clock, SwapProviderLimits.LightningSwap);
        for (var i = 0; i < 30; i += 1) budget.Reserve("create");

        var denied = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create"));

        Assert.Equal("Swap provider create budget exhausted (30+1 > 30).", denied.Message);
        Assert.Equal(SwapProviderWeightBudget.ReasonExhausted, denied.Reason);
        Assert.Equal(30, denied.Creates);
        Assert.Equal(30, denied.CreateLimit);
        Assert.Equal(30, denied.Used);
        Assert.Equal(400, denied.Gate);
        // The swaps that exist can still be read and refunded.
        budget.Reserve("order");
        budget.Reserve("emergency");
        clock += 60;
        budget.Reserve("create");
    }

    [Fact]
    public void Asking_whether_a_create_is_available_uses_no_budget()
    {
        var budget = new SwapProviderWeightBudget("ff", () => 1_000);
        for (var i = 0; i < 10; i += 1) budget.AssertAvailable("create");
        for (var i = 0; i < 3; i += 1) budget.Reserve("create");

        var asked = Assert.Throws<SwapWeightBudgetException>(() => budget.AssertAvailable("create"));
        var reserved = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create"));

        Assert.Equal("Swap provider API weight budget exhausted (150+50 > 150).", asked.Message);
        Assert.Equal(reserved.Denial, asked.Denial); // the check throws exactly what the reserve would
        Assert.Null(asked.Creates); // FixedFloat counts weight, not creates
        Assert.Null(asked.CreateLimit);
        budget.AssertAvailable("order");
    }

    [Fact]
    public void A_Lightning_Swap_429_on_a_create_stops_creates_for_the_wait_it_names_and_nothing_else()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("lightning-swap-com", () => clock, SwapProviderLimits.LightningSwap);

        budget.MarkRateLimited("create", 12);
        var denied = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create"));
        Assert.Equal(SwapProviderWeightBudget.ReasonBackoff, denied.Reason);
        Assert.Equal(1_012, denied.BackoffUntil);
        Assert.Equal(1_012, denied.RetryAt);
        Assert.Equal(1_000, denied.WindowStart); // the window did not restart: other calls go on
        budget.Reserve("order");
        clock = 1_012;
        budget.Reserve("create");

        // A 429 on any other call means the account's API budget is spent: all stop.
        budget.MarkRateLimited("order", 30);
        Assert.Equal("Swap provider API is in backoff until 1042.", Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order")).Message);
        Assert.Equal("Swap provider API is in backoff until 1042.", Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create")).Message);

        // No wait named: one minute. A day-long wait is retried after five minutes, because
        // the provider can lift it sooner. A fraction of a second is rounded up.
        clock = 2_000;
        budget.MarkRateLimited("create");
        Assert.Equal(2_060, Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create")).BackoffUntil);
        clock = 3_000;
        budget.MarkRateLimited("create", 86_000);
        Assert.Equal(3_300, Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create")).BackoffUntil);
        clock = 4_000;
        budget.MarkRateLimited("create", 1.2);
        Assert.Equal(4_002, Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("create")).BackoffUntil);
    }

    [Fact]
    public void A_FixedFloat_429_stops_every_call_for_at_least_a_minute_longer_when_it_says_so()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("ff", () => clock);

        budget.MarkRateLimited("create", 5);
        Assert.Equal("Swap provider API is in backoff until 1060.", Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order")).Message);
        clock = 2_000;
        budget.MarkRateLimited("create", 600);
        Assert.Equal("Swap provider API is in backoff until 2600.", Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order")).Message);
        clock = 5_000;
        budget.MarkRateLimited(retryAfterSeconds: 999_999);
        Assert.Equal("Swap provider API is in backoff until 8600.", Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order")).Message);

        // A wait that is not a wait (zero, negative, not a number) is the profile's minute.
        foreach (var wait in new[] { 0d, -3d, double.NaN, double.PositiveInfinity })
        {
            clock += 10_000;
            budget.MarkRateLimited("order", wait);
            Assert.Equal(clock + 60, Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order")).BackoffUntil);
        }
    }
}
