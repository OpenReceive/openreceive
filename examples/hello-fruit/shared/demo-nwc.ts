import { readNwcFromEnvironment } from "@openreceive/node";

/** Hello Fruit subject phrasing for the missing-NWC message. */
export function readRequiredHelloFruitNwcConnectionString(): string {
  return readNwcFromEnvironment({
    subject: "The Hello Fruit demo",
  });
}
