#nullable enable
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Abstractions.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>
/// BTCPay runs the plugin's migration at startup through its own host workflow. A startup
/// task runs before any hosted service starts (BTCPay's <c>StartWithTasksAsync</c>), so
/// the swap poller and the invoice-event listener never query a table that is not there yet.
/// </summary>
public sealed class PluginMigrationRunner : IStartupTask
{
    private readonly OpenReceiveDbContextFactory _factory;
    private readonly ILogger<PluginMigrationRunner> _logger;

    public PluginMigrationRunner(OpenReceiveDbContextFactory factory, ILogger<PluginMigrationRunner> logger)
    {
        _factory = factory;
        _logger = logger;
    }

    public async Task ExecuteAsync(CancellationToken cancellationToken = default)
    {
        await using var context = _factory.CreateContext();
        await context.Database.MigrateAsync(cancellationToken);
        _logger.LogInformation("OpenReceive: schema {Schema} is up to date", OpenReceivePluginDbContext.Schema);
    }
}
