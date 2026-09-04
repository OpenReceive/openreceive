#nullable enable
using System;
using System.Buffers.Binary;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Original Keccak-256 (Keccak-f[1600], rate 1088 bits, <c>0x01 … 0x80</c> padding) —
/// the hash Ethereum's EIP-55 address checksum uses. Not SHA3-256, whose padding
/// differs; there is no framework primitive for this variant.
/// </summary>
internal static class Keccak256
{
    private const int RateBytes = 136;

    private static readonly int[] Rotations =
    {
        0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
    };

    private static readonly ulong[] RoundConstants =
    {
        0x0000000000000001UL, 0x0000000000008082UL, 0x800000000000808aUL, 0x8000000080008000UL,
        0x000000000000808bUL, 0x0000000080000001UL, 0x8000000080008081UL, 0x8000000000008009UL,
        0x000000000000008aUL, 0x0000000000000088UL, 0x0000000080008009UL, 0x000000008000000aUL,
        0x000000008000808bUL, 0x800000000000008bUL, 0x8000000000008089UL, 0x8000000000008003UL,
        0x8000000000008002UL, 0x8000000000000080UL, 0x000000000000800aUL, 0x800000008000000aUL,
        0x8000000080008081UL, 0x8000000000008080UL, 0x0000000080000001UL, 0x8000000080008008UL,
    };

    public static byte[] Hash(ReadOnlySpan<byte> message)
    {
        var lanes = new ulong[25];
        var paddedLength = message.Length + RateBytes - (message.Length % RateBytes);
        var padded = new byte[paddedLength];
        message.CopyTo(padded);
        padded[message.Length] |= 0x01;
        padded[paddedLength - 1] |= 0x80;

        for (var offset = 0; offset < paddedLength; offset += RateBytes)
        {
            for (var lane = 0; lane < RateBytes / 8; lane += 1)
            {
                lanes[lane] ^= BinaryPrimitives.ReadUInt64LittleEndian(padded.AsSpan(offset + lane * 8, 8));
            }
            Permute(lanes);
        }

        var digest = new byte[32];
        for (var lane = 0; lane < 4; lane += 1)
        {
            BinaryPrimitives.WriteUInt64LittleEndian(digest.AsSpan(lane * 8, 8), lanes[lane]);
        }
        return digest;
    }

    private static ulong RotateLeft(ulong value, int bits) =>
        bits == 0 ? value : (value << bits) | (value >> (64 - bits));

    private static void Permute(ulong[] lanes)
    {
        Span<ulong> columns = stackalloc ulong[5];
        Span<ulong> theta = stackalloc ulong[5];
        Span<ulong> rotated = stackalloc ulong[25];
        foreach (var roundConstant in RoundConstants)
        {
            for (var x = 0; x < 5; x += 1)
            {
                columns[x] = lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20];
            }
            for (var x = 0; x < 5; x += 1)
            {
                theta[x] = columns[(x + 4) % 5] ^ RotateLeft(columns[(x + 1) % 5], 1);
            }
            for (var x = 0; x < 5; x += 1)
            {
                for (var y = 0; y < 5; y += 1)
                {
                    lanes[x + 5 * y] ^= theta[x];
                }
            }

            for (var x = 0; x < 5; x += 1)
            {
                for (var y = 0; y < 5; y += 1)
                {
                    rotated[y + 5 * ((2 * x + 3 * y) % 5)] = RotateLeft(lanes[x + 5 * y], Rotations[x + 5 * y]);
                }
            }

            for (var x = 0; x < 5; x += 1)
            {
                for (var y = 0; y < 5; y += 1)
                {
                    lanes[x + 5 * y] = rotated[x + 5 * y] ^ (~rotated[((x + 1) % 5) + 5 * y] & rotated[((x + 2) % 5) + 5 * y]);
                }
            }

            lanes[0] ^= roundConstant;
        }
    }
}
