import { readNwcFromConfig } from "@openreceive/node";

/** Hello Fruit subject phrasing for the missing-NWC message. */
export function readRequiredHelloFruitNwcConnectionString(): string {
  return readNwcFromConfig({
    cwd: process.cwd(),
    subject: "The Hello Fruit demo",
  });
}
