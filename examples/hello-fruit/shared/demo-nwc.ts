import {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  parseNwcUri
} from "@openreceive/core";

export function readRequiredHelloFruitNwcConnectionString(
  env: { readonly [key: string]: string | undefined } = process.env
): string {
  const value = env.OPENRECEIVE_NWC?.trim();
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
