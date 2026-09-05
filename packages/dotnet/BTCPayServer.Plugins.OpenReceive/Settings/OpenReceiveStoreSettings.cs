#nullable enable
using System;
using System.Collections.Generic;

namespace BTCPayServer.Plugins.OpenReceive.Settings;

/// <summary>
/// Per-store plugin settings, kept in BTCPay's store settings slot (IStoreRepository.UpdateSetting)
/// the way FixedFloat/SideShift keep their provider keys. The NWC code itself is NOT here: it
/// lives in the store's BTC-LN payment-method config as <c>type=openreceive;nwc=…</c>, the one
/// slot BTCPay reads to mint invoices and listen for payments. The spend override is derived
/// from that connection string on read, never stored independently, so the two cannot drift.
/// </summary>
public sealed class OpenReceiveStoreSettings
{
    /// <summary>Primary Lightning Swap Connect URI (lightning+swapconnect://…). Server-only.</summary>
    public string? LscPrimary { get; set; }
    /// <summary>Backup LSC URI, used only while the primary is down.</summary>
    public string? LscBackup { get; set; }
    /// <summary>Every pay-in asset the provider supports is offered: there is no per-store asset list.</summary>
    public bool SwapsEnabled { get; set; }
    /// <summary>Non-secret snapshot of the last wallet preflight, for the doctor page.</summary>
    public PreflightSnapshot? LastPreflight { get; set; }

    public sealed class PreflightSnapshot
    {
        public DateTimeOffset CheckedAt { get; set; }
        public bool Ok { get; set; }
        public string? Code { get; set; }
        public string? Message { get; set; }
        public string? WalletPubkey { get; set; }
        public List<string> Relays { get; set; } = new();
        public List<string> Methods { get; set; } = new();
        public List<string> SpendMethods { get; set; } = new();
        public List<string> Notifications { get; set; } = new();
        public string? Encryption { get; set; }
        public string? Network { get; set; }
        public double? RelayRoundTripMs { get; set; }
    }
}
