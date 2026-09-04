using System.Text.RegularExpressions;
using BTCPayServer.Plugins.OpenReceive.Data.Migrations;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Data;

/// <summary>
/// The hand-written migration spells the live-row filter (the partial unique index behind
/// "one live order per invoice and asset") as a literal; it must name exactly the kernel's
/// terminal states, or a kernel-tables change silently breaks the uniqueness rule.
/// </summary>
public sealed class MigrationTests
{
    [Fact]
    public void The_live_state_filter_names_exactly_the_generated_terminal_states()
    {
        Assert.StartsWith("state NOT IN (", InitialSwaps.LiveStateFilter);
        var quoted = Regex.Matches(InitialSwaps.LiveStateFilter, "'([a-z_]+)'").Select(m => m.Groups[1].Value).ToHashSet();
        Assert.Equal(SwapStates.TerminalStates.ToHashSet(), quoted);
    }
}
