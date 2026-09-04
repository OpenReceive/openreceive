#nullable enable
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>BTCPay runs the plugin's migration at startup through its own host workflow.</summary>
public sealed class PluginMigrationRunner : IHostedService
{
    private readonly OpenReceiveDbContextFactory _factory;
    private readonly ILogger<PluginMigrationRunner> _logger;

    public PluginMigrationRunner(OpenReceiveDbContextFactory factory, ILogger<PluginMigrationRunner> logger)
    {
        _factory = factory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        await context.Database.MigrateAsync(cancellationToken);
        _logger.LogInformation("OpenReceive: schema {Schema} is up to date", OpenReceivePluginDbContext.Schema);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
