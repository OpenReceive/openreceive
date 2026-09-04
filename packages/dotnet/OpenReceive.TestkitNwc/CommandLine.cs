namespace OpenReceive.TestkitNwc;

/// <summary>Hand-parsed process arguments (System.CommandLine is not a dependency).</summary>
public sealed record CommandLine
{
    public List<Uri> Relays { get; } = [];
    public string? LndConnectionString { get; init; }
    public string Network { get; init; } = "regtest";
    public List<string> Grants { get; } = [];
    public IReadOnlyList<string> EncryptionSchemes { get; init; } = TestkitWalletOptions.DefaultEncryptionSchemes;
    public bool DropOffset { get; init; }
    public bool NoNotifications { get; init; }
    public string? Lud16 { get; init; }
    public string? OutFile { get; init; }
    public int ControlPort { get; init; } = 7790;
    public bool InsecureTls { get; init; }
    public bool Help { get; init; }

    public const string Usage = """
        OpenReceive.TestkitNwc — a NIP-47 wallet service for end-to-end tests.

          --relay wss://host/         relay to serve on (repeatable; none = control API only)
          --memory                    in-memory invoices (default)
          --lnd "type=lnd-rest;..."   BTCPayServer.Lightning connection string
          --network regtest           regtest|mainnet|testnet|signet
          --grant pay_invoice         advertise a method that always answers NOT_IMPLEMENTED (repeatable)
          --encryption nip44_v2,nip04 advertised schemes; "nip04" forces the fallback; "none" omits the tag
          --drop-offset               simulate a wallet that ignores list_transactions offset
          --no-notifications          advertise no payment_received notifications (forces the poll path)
          --lud16 user@host           lightning address in the NWC URI
          --out /path/nwc-uri.txt     write the full NWC URI here (stdout only shows it redacted)
          --control-port 7790         HTTP control API port
          --insecure-tls              accept any relay TLS certificate
        """;

    public static CommandLine Parse(string[] args)
    {
        var result = new CommandLine();
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length
                ? args[++i]
                : throw new ArgumentException($"{args[i]} needs a value");
            switch (args[i])
            {
                case "--relay": result.Relays.Add(new Uri(Next())); break;
                case "--memory": result = result with { LndConnectionString = null }; break;
                case "--lnd": result = result with { LndConnectionString = Next() }; break;
                case "--network": result = result with { Network = Next() }; break;
                case "--grant": result.Grants.Add(Next()); break;
                case "--encryption":
                    var value = Next();
                    result = result with
                    {
                        EncryptionSchemes = value == "none"
                            ? []
                            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                    };
                    break;
                case "--drop-offset": result = result with { DropOffset = true }; break;
                case "--no-notifications": result = result with { NoNotifications = true }; break;
                case "--lud16": result = result with { Lud16 = Next() }; break;
                case "--out": result = result with { OutFile = Next() }; break;
                case "--control-port": result = result with { ControlPort = int.Parse(Next()) }; break;
                case "--insecure-tls": result = result with { InsecureTls = true }; break;
                case "--help" or "-h": result = result with { Help = true }; break;
                default: throw new ArgumentException($"Unknown argument {args[i]}");
            }
        }
        return result;
    }

    public TestkitWalletOptions ToWalletOptions() => new()
    {
        ExtraGrantedMethods = Grants,
        EncryptionSchemes = EncryptionSchemes,
        DropOffset = DropOffset,
        Notifications = !NoNotifications,
        Lud16 = Lud16,
    };
}
