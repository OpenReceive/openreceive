import assert from "node:assert/strict";
import test from "node:test";
import {
  getSwapRefundAddressError,
  isValidAddressForSwapNetwork,
  isValidSwapAddressForPayInAsset,
  openReceiveSwapAddressNetworkForPayInAsset,
} from "@openreceive/core/swap-address";
import { isValidSwapAddressForNetwork } from "../../packages/js/node/src/swap/assets.ts";

const ETH = "0x2222222222222222222222222222222222222222";
const SOL = "7EqQdEULxWcraVQ3XXtK5nGJm6tQ3nqJkGqZQ6c8bqKx";
const SOL_FULL = "BfMe1deFYJwaSeD9XoN1X8xw1PtcYjginrbvkQjS9w9U";
const SOL_TRUNCATED = "BfMe1deFYJwaSeD9XoN1X8xw1PtcYjginrbvkQjS9";
const TRX = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

test("openReceiveSwapAddressNetworkForPayInAsset maps every shipped pay-in asset", () => {
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("ETH_ETH"), "ETH");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("USDT_ETH"), "ETH");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("USDC_ETH"), "ETH");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("SOL_SOL"), "SOL");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("USDT_SOL"), "SOL");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("USDC_SOL"), "SOL");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("USDT_TRON"), "TRX");
  assert.equal(openReceiveSwapAddressNetworkForPayInAsset("UNKNOWN"), undefined);
});

test("isValidAddressForSwapNetwork accepts well-formed ETH / SOL / TRX addresses", () => {
  assert.equal(isValidAddressForSwapNetwork("ETH", ETH), true);
  assert.equal(isValidAddressForSwapNetwork("SOL", SOL), true);
  assert.equal(isValidAddressForSwapNetwork("SOL", SOL_FULL), true);
  assert.equal(isValidAddressForSwapNetwork("TRX", TRX), true);
  assert.equal(isValidAddressForSwapNetwork("TRON", TRX), true);
});

test("isValidAddressForSwapNetwork rejects truncated Solana addresses", () => {
  assert.equal(SOL_TRUNCATED.length >= 32, true);
  assert.equal(isValidAddressForSwapNetwork("SOL", SOL_TRUNCATED), false);
  assert.equal(isValidSwapAddressForPayInAsset("SOL_SOL", SOL_TRUNCATED), false);
  assert.equal(isValidSwapAddressForNetwork("SOL_SOL", SOL_TRUNCATED), false);
  assert.match(
    getSwapRefundAddressError("SOL_SOL", SOL_TRUNCATED, "Solana") ?? "",
    /full address/,
  );
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
    assert.equal(
      isValidSwapAddressForNetwork(asset, ETH),
      isValidSwapAddressForPayInAsset(asset, ETH),
      asset,
    );
    assert.equal(
      isValidSwapAddressForNetwork(asset, SOL),
      isValidSwapAddressForPayInAsset(asset, SOL),
      asset,
    );
    assert.equal(
      isValidSwapAddressForNetwork(asset, TRX),
      isValidSwapAddressForPayInAsset(asset, TRX),
      asset,
    );
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
  assert.match(
    getSwapRefundAddressError("ETH_ETH", SOL, "Ethereum") ?? "",
    /Ethereum.*0x/,
  );
  assert.match(
    getSwapRefundAddressError("SOL_SOL", ETH, "Solana") ?? "",
    /Solana/,
  );
  assert.match(
    getSwapRefundAddressError("USDT_TRON", ETH, "Tron") ?? "",
    /Tron.*starting with T/,
  );
  assert.match(
    getSwapRefundAddressError("USDC_ETH", TRX, "Ethereum") ?? "",
    /Ethereum.*0x/,
  );
  assert.match(
    getSwapRefundAddressError("USDT_SOL", TRX, "Solana") ?? "",
    /Solana/,
  );
});
