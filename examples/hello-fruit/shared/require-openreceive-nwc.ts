import {
  readRequiredHelloFruitNwcConnectionString
} from "./demo-nwc.ts";

try {
  readRequiredHelloFruitNwcConnectionString();
} catch (error) {
  console.error([
    "",
    error instanceof Error ? error.message : String(error),
    ""
  ].join("\n"));
  process.exit(1);
}
