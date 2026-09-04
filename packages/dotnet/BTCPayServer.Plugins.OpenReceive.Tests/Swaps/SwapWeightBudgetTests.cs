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

        clock = 1_060; // window rolls here, the backoff must not
        var error = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));
        Assert.Equal(SwapProviderWeightBudget.ReasonBackoff, error.Reason);
        Assert.Equal(1_119, error.BackoffUntil);
        Assert.Equal(1_060, error.WindowStart);
        Assert.Equal("Swap provider API is in backoff until 1119.", error.Message);

        clock = 1_118;
        Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));

        clock = 1_119;
        budget.Reserve("order");
    }

    [Fact]
    public void Rate_limit_mark_exhausts_the_current_window()
    {
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("ff", () => clock);
        budget.Reserve("order");

        clock = 1_030;
        budget.MarkRateLimited();

        clock = 1_059; // same window: the denial reports the cap as used, on top of the backoff
        var error = Assert.Throws<SwapWeightBudgetException>(() => budget.Reserve("order"));
        Assert.Equal(SwapProviderWeightBudget.ReasonBackoff, error.Reason);
        Assert.Equal(200, error.Used);
        Assert.Equal(1_090, error.BackoffUntil);

        clock = 1_090; // backoff over and the window has rolled
        budget.Reserve("order");
    }
}
