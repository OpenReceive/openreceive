using System.Net.Security;
using System.Net.WebSockets;
using Microsoft.Extensions.Logging;
using OpenReceive.TestkitNwc;

CommandLine options;
try
{
    options = CommandLine.Parse(args);
}
catch (Exception e)
{
    Console.Error.WriteLine(e.Message);
    Console.Error.WriteLine(CommandLine.Usage);
    return 2;
}
if (options.Help)
{
    Console.WriteLine(CommandLine.Usage);
    return 0;
}

using var loggerFactory = LoggerFactory.Create(b => b.AddSimpleConsole(o => o.SingleLine = true).SetMinimumLevel(LogLevel.Information));
var log = loggerFactory.CreateLogger("testkit-nwc");
var shutdown = new CancellationTokenSource(); // process-lifetime: never disposed, so late ProcessExit cannot trip on it
Console.CancelKeyPress += (_, e) => { e.Cancel = true; shutdown.Cancel(); };
AppDomain.CurrentDomain.ProcessExit += (_, _) => shutdown.Cancel();

try
{
    var network = NetworkNames.Parse(options.Network);
    IWalletBackend backend = options.LndConnectionString is { } lnd
        ? new LndWalletBackend(lnd, network, loggerFactory.CreateLogger<LndWalletBackend>())
        : new InMemoryWalletBackend(NetworkNames.Nip47Name(network));
    var service = new TestkitWalletService(backend, options.ToWalletOptions())
    {
        Logger = loggerFactory.CreateLogger<TestkitWalletService>(),
    };

    var uri = service.NwcUri(options.Relays.ToArray());
    if (options.OutFile is { } outFile)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outFile))!);
        await File.WriteAllTextAsync(outFile, uri + "\n", shutdown.Token);
    }
    Console.WriteLine($"NWC URI: {TestkitWalletService.RedactUri(uri)}");
    log.LogInformation("Backend {Backend} on {Network}; methods {Methods}; encryption {Encryption}; control API on :{Port}",
        backend.GetType().Name, backend.Network, string.Join(" ", service.Options.GrantedMethods),
        service.Options.EncryptionSchemes.Count == 0 ? "(no tag)" : string.Join(" ", service.Options.EncryptionSchemes),
        options.ControlPort);

    TestkitRelayRunner? runner = null;
    var tasks = new List<Task>();
    if (options.Relays.Count > 0)
    {
        Action<WebSocket>? configure = options.InsecureTls
            ? socket =>
            {
                if (socket is ClientWebSocket client)
                    client.Options.RemoteCertificateValidationCallback = static (_, _, _, _) => true;
            }
            : null;
        runner = new TestkitRelayRunner(service, options.Relays.ToArray(), loggerFactory.CreateLogger<TestkitRelayRunner>(), configure);
        tasks.Add(runner.RunAsync(shutdown.Token));
    }
    else
    {
        log.LogWarning("No --relay given: serving the control API only");
    }
    if (backend is LndWalletBackend lndBackend)
        tasks.Add(lndBackend.ListenAsync(shutdown.Token));

    var control = ControlApi.Build(options.ControlPort, service, backend, () => runner?.RelayConnected ?? false, uri);
    tasks.Add(control.RunAsync(shutdown.Token));

    var finished = await Task.WhenAny(tasks);
    await finished; // surface the failure, if any
    if (!shutdown.IsCancellationRequested)
    {
        log.LogError("A component stopped unexpectedly; exiting");
        return 1;
    }
    return 0;
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
{
    return 0;
}
catch (Exception e)
{
    log.LogCritical(e, "Fatal: {Message}", e.Message);
    return 1;
}
