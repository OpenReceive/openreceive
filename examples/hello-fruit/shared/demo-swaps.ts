import {
  createFixedFloatProviderFromEnv,
  type OpenReceiveSwapProvider
} from "@openreceive/node";

export function createHelloFruitSwapProviders(
  env: Record<string, string | undefined> = process.env
): readonly OpenReceiveSwapProvider[] {
  const provider = createFixedFloatProviderFromEnv(env);
  return provider === undefined ? [] : [provider];
}
