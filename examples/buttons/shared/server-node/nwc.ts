import { readNwcFromEnvironment } from "@openreceive/node";

/**
 * Sentinel returned instead of a real NWC connection string when a demo runs
 * in testkit wallet mode (`DEMO_WALLET=testkit`). Never a valid NWC URI — any
 * code path that would hand it to a real wallet client must branch on
 * {@link shopWalletMode} first.
 */
export const SHOP_TESTKIT_WALLET_SENTINEL = "buttons-testkit-wallet";

export type ShopWalletMode = "testkit" | "nwc";

/**
 * `DEMO_WALLET=testkit` runs a demo against the in-memory
 * `@openreceive/testkit` fakes — no NWC_URI, no network. That is the E2E
 * harness's mode; any other value keeps the real wallet path.
 */
export function shopWalletMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ShopWalletMode {
  return env.DEMO_WALLET === "testkit" ? "testkit" : "nwc";
}

export function readRequiredShopNwcConnectionString(): string {
  if (shopWalletMode() === "testkit") return SHOP_TESTKIT_WALLET_SENTINEL;
  return readNwcFromEnvironment({ subject: "The Buy a Button demo" });
}
