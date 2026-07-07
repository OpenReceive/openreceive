import {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  parseNwcUri
} from "@openreceive/core";
import { readOpenReceiveConfigFile } from "@openreceive/node";

export function readRequiredHelloFruitNwcConnectionString(
  env: { readonly [key: string]: string | undefined } = process.env
): string {
  const value = (
    readOpenReceiveConfigFile({ cwd: process.cwd() })?.nwc ??
    env.OPENRECEIVE_NWC
  )?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(formatOpenReceiveMissingNwcMessage({
      subject: "The Hello Fruit demo"
    }));
  }

  try {
    parseNwcUri(value);
  } catch (error) {
    const reason = error instanceof NwcUriParseError
      ? error.description
      : "Invalid NWC URI.";
    throw new Error(formatOpenReceiveInvalidNwcMessage({ reason }));
  }

  return value;
}
