import { readNwcFromEnvironment } from "@openreceive/node";

/**
 * Sentinel returned instead of a real NWC connection string when the demo runs
 * in testkit wallet mode (`DEMO_WALLET=testkit`). Never a valid NWC URI — any
 * code path that would hand it to a real wallet client must branch on
 * {@link helloFruitDemoWalletMode} first.
 */
export const HELLO_FRUIT_TESTKIT_WALLET_SENTINEL = "hello-fruit-testkit-wallet";

export type HelloFruitDemoWalletMode = "testkit" | "nwc";

/**
 * The demo wallet mode switch. `DEMO_WALLET=testkit` runs the demo against the
 * in-memory `@openreceive/testkit` fakes (no NWC_URI needed — E2E harness
 * mode); any other value keeps the real NWC wallet path.
 */
export function helloFruitDemoWalletMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HelloFruitDemoWalletMode {
  return env.DEMO_WALLET === "testkit" ? "testkit" : "nwc";
}

/**
 * Hello Fruit subject phrasing for the missing-NWC message. In testkit wallet
 * mode this returns {@link HELLO_FRUIT_TESTKIT_WALLET_SENTINEL} instead of
 * requiring NWC_URI; otherwise behavior is unchanged.
 */
export function readRequiredHelloFruitNwcConnectionString(): string {
  if (helloFruitDemoWalletMode() === "testkit") {
    return HELLO_FRUIT_TESTKIT_WALLET_SENTINEL;
  }
  return readNwcFromEnvironment({
    subject: "The Hello Fruit demo",
  });
}
