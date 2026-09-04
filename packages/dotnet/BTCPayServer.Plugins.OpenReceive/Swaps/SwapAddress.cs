#nullable enable
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Address validation for swap deposit/refund networks. These are checksum checks,
/// not shape guards: a refund address is typed or pasted by a payer and a false
/// accept sends money nowhere recoverable.
/// <list type="bullet">
/// <item><c>TRX</c> — Base58Check: 25 bytes, <c>0x41</c> mainnet prefix, double-SHA-256 tail.</item>
/// <item><c>ETH</c> — EIP-55 capitalization verified whenever the address carries mixed case.</item>
/// <item><c>SOL</c> — decodes to exactly a 32-byte ed25519 public key.</item>
/// </list>
/// A network OpenReceive does not know is rejected outright.
/// </summary>
public static partial class SwapAddress
{
    private const string Base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    private static readonly Dictionary<char, int> Base58Map = BuildBase58Map();

    /// <summary>Tron mainnet address version byte; testnet/other prefixes are not payable here.</summary>
    private const byte TronAddressPrefix = 0x41;
    private const int Base58CheckChecksumBytes = 4;
    private const int MaxSwapAddressLength = 200;

    [GeneratedRegex("^0x[0-9a-fA-F]{40}$")]
    private static partial Regex EthAddressShape();

    [GeneratedRegex("^T[1-9A-HJ-NP-Za-km-z]{33}$")]
    private static partial Regex TronAddressShape();

    [GeneratedRegex("^[1-9A-HJ-NP-Za-km-z]{32,44}$")]
    private static partial Regex SolanaAddressShape();

    [GeneratedRegex(@"\s")]
    private static partial Regex Whitespace();

    private static Dictionary<char, int> BuildBase58Map()
    {
        var map = new Dictionary<char, int>(Base58Alphabet.Length);
        for (var i = 0; i < Base58Alphabet.Length; i += 1) map[Base58Alphabet[i]] = i;
        return map;
    }

    /// <summary>Bitcoin/Solana base58 decode; null on invalid characters. Leading '1's are leading zero bytes.</summary>
    private static byte[]? DecodeBase58(string value)
    {
        if (value.Length == 0) return null;
        // Start empty: seeding with [0] added a spurious zero byte for inputs whose
        // big-number value is zero (the all-'1' Solana System Program address).
        var bytes = new List<byte>();
        foreach (var character in value)
        {
            if (!Base58Map.TryGetValue(character, out var digit)) return null;
            var carry = digit;
            for (var i = 0; i < bytes.Count; i += 1)
            {
                carry += bytes[i] * 58;
                bytes[i] = (byte)(carry & 0xff);
                carry >>= 8;
            }
            while (carry > 0)
            {
                bytes.Add((byte)(carry & 0xff));
                carry >>= 8;
            }
        }
        foreach (var character in value)
        {
            if (character != '1') break;
            bytes.Add(0);
        }
        bytes.Reverse();
        return bytes.ToArray();
    }

    /// <summary>
    /// Resolve an accepted network spelling, or null for one we cannot check. <c>TRON</c>
    /// is the only alias: the suffix OpenReceive's pay_in_asset codes use (<c>USDT_TRON</c>).
    /// </summary>
    private static string? NormalizeNetwork(string network) => network switch
    {
        "ETH" => "ETH",
        "SOL" => "SOL",
        "TRX" or "TRON" => "TRX",
        _ => null,
    };

    private static bool IsValidTronAddress(string address)
    {
        if (!TronAddressShape().IsMatch(address)) return false;
        var decoded = DecodeBase58(address);
        if (decoded is null || decoded.Length != 21 + Base58CheckChecksumBytes) return false;
        if (decoded[0] != TronAddressPrefix) return false;
        var payload = decoded.AsSpan(0, 21);
        var checksum = decoded.AsSpan(21);
        var expected = SHA256.HashData(SHA256.HashData(payload));
        for (var i = 0; i < Base58CheckChecksumBytes; i += 1)
        {
            if (checksum[i] != expected[i]) return false;
        }
        return true;
    }

    private static bool IsValidEthereumAddress(string address)
    {
        if (!EthAddressShape().IsMatch(address)) return false;
        var body = address[2..];
        var lowercase = body.ToLowerInvariant();
        // No mixed case means no EIP-55 bits to verify — accept on shape, like every
        // Ethereum wallet does for an all-lower or all-upper address.
        if (body == lowercase || body == body.ToUpperInvariant()) return true;
        var digest = Keccak256.Hash(Encoding.ASCII.GetBytes(lowercase));
        for (var i = 0; i < lowercase.Length; i += 1)
        {
            var character = lowercase[i];
            if (character < 'a' || character > 'f') continue;
            // EIP-55: nibble i of keccak256(lowercase hex) >= 8 means uppercase.
            var nibble = i % 2 == 0 ? digest[i >> 1] >> 4 : digest[i >> 1] & 0x0f;
            var shouldBeUpper = nibble >= 8;
            if (shouldBeUpper != (body[i] == char.ToUpperInvariant(character))) return false;
        }
        return true;
    }

    private static bool IsValidSolanaAddress(string address)
    {
        // Typical encoded length is 32–44; still require a 32-byte pubkey decode, so
        // a truncated paste (or a 25-byte Base58Check address) cannot slip through.
        if (!SolanaAddressShape().IsMatch(address)) return false;
        var decoded = DecodeBase58(address);
        return decoded is not null && decoded.Length == 32;
    }

    /// <summary>
    /// True when <paramref name="address"/> is a payable address on <paramref name="network"/>,
    /// checksum included. Any network other than ETH, SOL, TRX (or the TRON alias) is rejected.
    /// </summary>
    public static bool IsValidAddressForSwapNetwork(string network, string address)
    {
        if (address.Length > MaxSwapAddressLength || Whitespace().IsMatch(address)) return false;
        return NormalizeNetwork(network) switch
        {
            "ETH" => IsValidEthereumAddress(address),
            "SOL" => IsValidSolanaAddress(address),
            "TRX" => IsValidTronAddress(address),
            _ => false,
        };
    }

    /// <summary>
    /// The chain-network suffix of an OpenReceive pay_in_asset code, uppercased:
    /// <c>USDT_ETH</c> → ETH, <c>USDT_TRON</c> → TRON. A code with no suffix answers itself.
    /// </summary>
    public static string? PayInAssetNetwork(string payInAsset)
    {
        if (payInAsset.Length == 0) return null;
        var lastUnderscore = payInAsset.LastIndexOf('_');
        return (lastUnderscore < 0 ? payInAsset : payInAsset[(lastUnderscore + 1)..]).ToUpperInvariant();
    }

    /// <summary>The address network (ETH, SOL, TRX) for a pay_in_asset code, or null when unknown.</summary>
    public static string? NetworkForPayInAsset(string payInAsset)
    {
        var suffix = PayInAssetNetwork(payInAsset);
        return suffix is null ? null : NormalizeNetwork(suffix);
    }

    /// <summary>
    /// True when the address is payable for the asset's network. For an asset whose
    /// network OpenReceive does not know, no checksum rule exists, so the check
    /// degrades to a bounded non-empty string — deliberately, and only there.
    /// </summary>
    public static bool IsValidSwapAddressForPayInAsset(string payInAsset, string address)
    {
        var network = NetworkForPayInAsset(payInAsset);
        if (network is null)
        {
            return address.Length >= 5 && address.Length <= MaxSwapAddressLength && !Whitespace().IsMatch(address);
        }
        return IsValidAddressForSwapNetwork(network, address);
    }

    /// <summary>Payer-facing refund address error, or null when the address is empty or valid.</summary>
    public static string? RefundAddressError(string payInAsset, string address, string networkLabel)
    {
        var trimmed = address.Trim();
        if (trimmed.Length == 0) return null;
        if (IsValidSwapAddressForPayInAsset(payInAsset, trimmed)) return null;
        var network = NetworkForPayInAsset(payInAsset);
        if (network == "ETH")
        {
            if (EthAddressShape().IsMatch(trimmed))
            {
                return $"That {networkLabel} address failed its checksum. Copy it again from your wallet.";
            }
            return $"That doesn't look like an {networkLabel} address. Use a 0x address.";
        }
        if (network == "TRX")
        {
            if (TronAddressShape().IsMatch(trimmed))
            {
                return $"That {networkLabel} address failed its checksum. Copy it again from your wallet.";
            }
            return $"That doesn't look like a {networkLabel} address. Use an address starting with T.";
        }
        return $"That doesn't look like a {networkLabel} address. Check you pasted the full address.";
    }
}
