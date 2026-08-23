#!/usr/bin/env node

// examples/hello-fruit/shared/demo-currencies.ts owns the demo currency data:
// which currencies checkout offers, which of them are direct bitcoin units,
// and the fiat minor-unit widths. The Rails demo is the one client that cannot
// import it, so it mirrors the constants in Ruby
// (app/models/create_fruit_order.rb, app/models/money_format.rb). Nothing else
// notices when one side changes, so this check parses both and compares.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = path.resolve(demoRoot, "../../shared");

const findings = [];

function readSource(filePath) {
  return readFileSync(filePath, "utf8");
}

function quotedList(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

// --- TypeScript side (the owner) --------------------------------------------

const currenciesTs = readSource(path.join(sharedRoot, "demo-currencies.ts"));

const tsDirectMatch = currenciesTs.match(/HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES\s*=\s*\[([^\]]*)\]/);
const tsDirect = tsDirectMatch === null ? null : quotedList(tsDirectMatch[1]);

const tsCheckoutMatch = currenciesTs.match(
  /readHelloFruitCheckoutCurrencies\(\)[^{]*\{\s*return\s*\[([^\]]*?)\.\.\.HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES\]/,
);
const tsFiat = tsCheckoutMatch === null ? null : quotedList(tsCheckoutMatch[1]);

const tsFractionMatch = currenciesTs.match(/HELLO_FRUIT_FIAT_FRACTION_DIGITS[^={]*=\s*\{([^}]*)\}/);
const tsFractionDigits =
  tsFractionMatch === null
    ? null
    : Object.fromEntries(
        [...tsFractionMatch[1].matchAll(/["']?([A-Z][A-Z0-9]+)["']?\s*:\s*(\d+)/g)].map((match) => [
          match[1],
          Number(match[2]),
        ]),
      );

if (tsDirect === null || tsFiat === null || tsFractionDigits === null) {
  findings.push(
    "could not parse shared/demo-currencies.ts (HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES, " +
      "readHelloFruitCheckoutCurrencies, HELLO_FRUIT_FIAT_FRACTION_DIGITS). " +
      "Update the patterns in this script alongside the file.",
  );
}

// --- Ruby side (the mirror) --------------------------------------------------

const createOrderRb = readSource(path.join(demoRoot, "app/models/create_fruit_order.rb"));

const rubyDirectMatch = createOrderRb.match(/DIRECT_CURRENCIES\s*=\s*%w\[([^\]]*)\]/);
const rubyDirect = rubyDirectMatch === null ? null : rubyDirectMatch[1].trim().split(/\s+/);

const rubySupportedMatch = createOrderRb.match(
  /SUPPORTED\s*=\s*\(%w\[([^\]]*)\]\s*\+\s*DIRECT_CURRENCIES\)/,
);
const rubyFiat = rubySupportedMatch === null ? null : rubySupportedMatch[1].trim().split(/\s+/);

const moneyFormatRb = readSource(path.join(demoRoot, "app/models/money_format.rb"));
const rubyFractionMatch = moneyFormatRb.match(/MIN_FRACTION_DIGITS\s*=\s*\{([^}]*)\}/);
const rubyFractionDigits =
  rubyFractionMatch === null
    ? null
    : Object.fromEntries(
        [...rubyFractionMatch[1].matchAll(/"([A-Z][A-Z0-9]+)"\s*=>\s*(\d+)/g)].map((match) => [
          match[1],
          Number(match[2]),
        ]),
      );

if (rubyDirect === null || rubyFiat === null || rubyFractionDigits === null) {
  findings.push(
    "could not parse the Rails mirrors (CreateFruitOrder::DIRECT_CURRENCIES, " +
      "CreateFruitOrder::SUPPORTED, MoneyFormat::MIN_FRACTION_DIGITS). " +
      "Update the patterns in this script alongside the models.",
  );
}

// --- Compare -----------------------------------------------------------------

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

if (findings.length === 0) {
  if (!sameList(rubyDirect, tsDirect)) {
    findings.push(
      `CreateFruitOrder::DIRECT_CURRENCIES [${rubyDirect}] != ` +
        `HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES [${tsDirect}].`,
    );
  }

  const rubySupported = [...rubyFiat, ...rubyDirect];
  const tsSupported = [...tsFiat, ...tsDirect];
  if (!sameList(rubySupported, tsSupported)) {
    findings.push(
      `CreateFruitOrder::SUPPORTED [${rubySupported}] != ` +
        `readHelloFruitCheckoutCurrencies() [${tsSupported}].`,
    );
  }

  const rubyPairs = JSON.stringify(rubyFractionDigits);
  const tsPairs = JSON.stringify(tsFractionDigits);
  if (rubyPairs !== tsPairs) {
    findings.push(
      `MoneyFormat::MIN_FRACTION_DIGITS ${rubyPairs} != ` +
        `HELLO_FRUIT_FIAT_FRACTION_DIGITS ${tsPairs}.`,
    );
  }

  for (const currency of Object.keys(tsFractionDigits)) {
    if (!tsFiat.includes(currency)) {
      findings.push(
        `HELLO_FRUIT_FIAT_FRACTION_DIGITS names ${currency}, which is not a fiat ` +
          "checkout currency in demo-currencies.ts.",
      );
    }
  }
}

if (findings.length > 0) {
  console.error("Rails demo currency constants have drifted from shared/demo-currencies.ts:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Currency drift check passed: Rails mirrors demo-currencies.ts ` +
    `(checkout currencies [${[...tsFiat, ...tsDirect].join(", ")}]; ` +
    `fraction digits ${JSON.stringify(tsFractionDigits)}).`,
);
