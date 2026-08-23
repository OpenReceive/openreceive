import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getSwapRefundAddressError,
  isValidAddressForSwapNetwork,
  isValidSwapAddressForPayInAsset,
  swapAddressNetworkForPayInAsset,
} from "@openreceive/core/swap-address";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import { isValidSwapAddressForNetwork } from "../packages/js/node/src/swap/assets.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../packages/js/testkit/src/index.ts";

// EIP-55 checksummed (mixed case).
const ETH = "0x2222222222222222222222222222222222222222";
const ETH_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ETH_LOWERCASE = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const ETH_UPPERCASE = "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED";
// One capitalization bit flipped: right shape, wrong EIP-55 checksum.
const ETH_BAD_CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";
const SOL = "7EqQdEULxWcraVQ3XXtK5nGJm6tQ3nqJkGqZQ6c8bqKx";
const SOL_FULL = "BfMe1deFYJwaSeD9XoN1X8xw1PtcYjginrbvkQjS9w9U";
const SOL_TRUNCATED = "BfMe1deFYJwaSeD9XoN1X8xw1PtcYjginrbvkQjS9";
// Valid Base58Check (0x41 prefix + double-SHA-256 tail).
const TRX = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const TRX_OTHER = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// Same shape, last character changed: the checksum no longer matches.
const TRX_BAD_CHECKSUM = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u";

test("swapAddressNetworkForPayInAsset maps every shipped pay-in asset", () => {
  assert.equal(swapAddressNetworkForPayInAsset("ETH_ETH"), "ETH");
  assert.equal(swapAddressNetworkForPayInAsset("USDT_ETH"), "ETH");
  assert.equal(swapAddressNetworkForPayInAsset("USDC_ETH"), "ETH");
  assert.equal(swapAddressNetworkForPayInAsset("SOL_SOL"), "SOL");
  assert.equal(swapAddressNetworkForPayInAsset("USDT_SOL"), "SOL");
  assert.equal(swapAddressNetworkForPayInAsset("USDC_SOL"), "SOL");
  assert.equal(swapAddressNetworkForPayInAsset("USDT_TRON"), "TRX");
  assert.equal(swapAddressNetworkForPayInAsset("UNKNOWN"), undefined);
});

test("isValidAddressForSwapNetwork accepts well-formed ETH / SOL / TRX addresses", () => {
  assert.equal(isValidAddressForSwapNetwork("ETH", ETH), true);
  assert.equal(isValidAddressForSwapNetwork("ETH", ETH_CHECKSUMMED), true);
  assert.equal(isValidAddressForSwapNetwork("SOL", SOL), true);
  assert.equal(isValidAddressForSwapNetwork("SOL", SOL_FULL), true);
  assert.equal(isValidAddressForSwapNetwork("TRX", TRX), true);
  assert.equal(isValidAddressForSwapNetwork("TRON", TRX), true);
  assert.equal(isValidAddressForSwapNetwork("TRX", TRX_OTHER), true);
});

test("Tron addresses must pass Base58Check, not just the T… shape", () => {
  assert.equal(TRX_BAD_CHECKSUM.length, TRX_OTHER.length);
  assert.equal(isValidAddressForSwapNetwork("TRX", TRX_BAD_CHECKSUM), false);
  assert.equal(isValidSwapAddressForPayInAsset("USDT_TRON", TRX_BAD_CHECKSUM), false);
  assert.equal(isValidSwapAddressForNetwork("USDT_TRON", TRX_BAD_CHECKSUM), false);
  assert.match(
    getSwapRefundAddressError("USDT_TRON", TRX_BAD_CHECKSUM, "Tron") ?? "",
    /Tron address failed its checksum/,
  );
});

test("mixed-case Ethereum addresses must pass EIP-55; single-case ones carry no checksum", () => {
  assert.equal(isValidAddressForSwapNetwork("ETH", ETH_BAD_CHECKSUM), false);
  assert.equal(isValidSwapAddressForPayInAsset("USDT_ETH", ETH_BAD_CHECKSUM), false);
  assert.equal(isValidSwapAddressForNetwork("USDT_ETH", ETH_BAD_CHECKSUM), false);
  assert.match(
    getSwapRefundAddressError("ETH_ETH", ETH_BAD_CHECKSUM, "Ethereum") ?? "",
    /Ethereum address failed its checksum/,
  );

  // No mixed case means no EIP-55 bits to verify — both stay valid.
  assert.equal(isValidAddressForSwapNetwork("ETH", ETH_LOWERCASE), true);
  assert.equal(isValidAddressForSwapNetwork("ETH", ETH_UPPERCASE), true);
  assert.equal(getSwapRefundAddressError("ETH_ETH", ETH_LOWERCASE, "Ethereum"), undefined);
});

test("isValidAddressForSwapNetwork rejects truncated Solana addresses", () => {
  assert.equal(SOL_TRUNCATED.length >= 32, true);
  assert.equal(isValidAddressForSwapNetwork("SOL", SOL_TRUNCATED), false);
  assert.equal(isValidSwapAddressForPayInAsset("SOL_SOL", SOL_TRUNCATED), false);
  assert.equal(isValidSwapAddressForNetwork("SOL_SOL", SOL_TRUNCATED), false);
  assert.match(getSwapRefundAddressError("SOL_SOL", SOL_TRUNCATED, "Solana") ?? "", /full address/);
});

test("isValidAddressForSwapNetwork rejects wrong-network and malformed addresses", () => {
  assert.equal(isValidAddressForSwapNetwork("ETH", SOL), false);
  assert.equal(isValidAddressForSwapNetwork("ETH", TRX), false);
  assert.equal(isValidAddressForSwapNetwork("ETH", "0xabc"), false);
  assert.equal(isValidAddressForSwapNetwork("ETH", ` ${ETH}`), false);
  assert.equal(isValidAddressForSwapNetwork("SOL", ETH), false);
  assert.equal(isValidAddressForSwapNetwork("SOL", TRX), false);
  assert.equal(isValidAddressForSwapNetwork("SOL", "O0Il"), false);
  assert.equal(isValidAddressForSwapNetwork("TRX", ETH), false);
  assert.equal(isValidAddressForSwapNetwork("TRX", SOL), false);
  assert.equal(isValidAddressForSwapNetwork("TRX", "XYZ"), false);
});

test("an unknown network is rejected outright, never waved through on length", () => {
  // "ETh" is a typo, not a network: the old length>=5 fallback accepted almost
  // anything for it.
  assert.equal(isValidAddressForSwapNetwork("ETh", ETH_CHECKSUMMED), false);
  assert.equal(isValidAddressForSwapNetwork("ETh", "definitely-not-an-address"), false);
  assert.equal(isValidAddressForSwapNetwork("", ETH_CHECKSUMMED), false);
  assert.equal(isValidAddressForSwapNetwork("BTC", ETH_CHECKSUMMED), false);
});

test("node isValidSwapAddressForNetwork matches shared pay-in-asset checks", () => {
  for (const asset of [
    "ETH_ETH",
    "USDT_ETH",
    "USDC_ETH",
    "SOL_SOL",
    "USDT_SOL",
    "USDC_SOL",
    "USDT_TRON",
  ]) {
    for (const address of [ETH, ETH_CHECKSUMMED, ETH_BAD_CHECKSUM, SOL, TRX, TRX_BAD_CHECKSUM]) {
      assert.equal(
        isValidSwapAddressForNetwork(asset, address),
        isValidSwapAddressForPayInAsset(asset, address),
        `${asset} / ${address}`,
      );
    }
  }
  assert.equal(isValidSwapAddressForNetwork("ETH_ETH", ETH), true);
  assert.equal(isValidSwapAddressForNetwork("SOL_SOL", SOL), true);
  assert.equal(isValidSwapAddressForNetwork("USDT_TRON", TRX), true);
  assert.equal(isValidSwapAddressForNetwork("ETH_ETH", SOL), false);
  assert.equal(isValidSwapAddressForNetwork("SOL_SOL", ETH), false);
  assert.equal(isValidSwapAddressForNetwork("USDT_TRON", ETH), false);
});

test("getSwapRefundAddressError returns network-specific copy", () => {
  assert.equal(getSwapRefundAddressError("ETH_ETH", "", "Ethereum"), undefined);
  assert.equal(getSwapRefundAddressError("ETH_ETH", ETH, "Ethereum"), undefined);
  assert.match(getSwapRefundAddressError("ETH_ETH", SOL, "Ethereum") ?? "", /Ethereum.*0x/);
  assert.match(getSwapRefundAddressError("SOL_SOL", ETH, "Solana") ?? "", /Solana/);
  assert.match(getSwapRefundAddressError("USDT_TRON", ETH, "Tron") ?? "", /Tron.*starting with T/);
  assert.match(getSwapRefundAddressError("USDC_ETH", TRX, "Ethereum") ?? "", /Ethereum.*0x/);
  assert.match(getSwapRefundAddressError("USDT_SOL", TRX, "Solana") ?? "", /Solana/);
});

test("the server refund path rejects an address that fails its network checksum", async () => {
  const openreceive = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    swap: { provider: createTestkitSwapProvider({ now: () => 1000 }) },
    clock: () => 1000,
  });
  try {
    const swap = await openreceive.createSwap({
      orderId: "swap-refund-checksum",
      amount: { sats: 20_000 },
      payInAsset: "USDT_TRON",
    });
    const swapData = JSON.parse(JSON.stringify(swap.swapData));
    const refund = (refundAddress) =>
      openreceive.refundSwap({
        orderId: swap.orderId,
        paymentHash: swap.paymentHash,
        swapData,
        refundAddress,
      });

    // Refusal happens before any provider state is touched, so the payer is
    // told to fix the address rather than losing the refund to it.
    await assert.rejects(refund(TRX_BAD_CHECKSUM), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.body.message, /refundAddress is not a valid USDT_TRON address/);
      return true;
    });
    await assert.rejects(refund(ETH_CHECKSUMMED), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
    await assert.rejects(refund("   "), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    await openreceive.close();
  }
});

test("the all-'1' Solana System Program address decodes to 32 zero bytes and validates", () => {
  assert.equal(isValidAddressForSwapNetwork("SOL", "11111111111111111111111111111111"), true);
  // 31 leading '1' chars decode to 31 zero bytes: one short of a pubkey.
  assert.equal(isValidAddressForSwapNetwork("SOL", "1".repeat(31)), false);
});

test("both engines validate the shared swap-address vectors identically", () => {
  const vector = JSON.parse(readFileSync("spec/test-vectors/swap-address.json", "utf8"));
  for (const item of vector.cases) {
    assert.equal(
      isValidAddressForSwapNetwork(item.network, item.address),
      item.expected.valid,
      item.name,
    );
  }
});
