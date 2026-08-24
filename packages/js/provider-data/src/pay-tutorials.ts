import { assetUrl } from "./asset-url.ts";

// One filename list drives the whole map, mirroring provider-icons.ts — two
// patterns for one concept in one package was the drift risk. The list matches
// the registry's tutorial `path` references exactly (a test pins every
// referenced tutorial to an entry here).
export const OPENRECEIVE_PAY_TUTORIAL_FILES: readonly string[] = [
  "boltz-1.webp",
  "boltz-2.webp",
  "cashapp-1.webp",
  "cashapp-2.webp",
  "cashapp-3.webp",
  "cashapp-4.webp",
  "cashapp-5.webp",
  "cashapp-6.webp",
  "coinbase-1.webp",
  "coinbase-2.webp",
  "fixedfloat-1.webp",
  "fixedfloat-2.webp",
  "kraken-1.webp",
  "kraken-2.webp",
  "kraken-3.webp",
  "kraken-4.webp",
  "strike-1.webp",
  "strike-2.webp",
  "strike-3.webp",
  "strike-4.webp",
];

export const payTutorialUrls: Readonly<Record<string, string>> = Object.fromEntries(
  OPENRECEIVE_PAY_TUTORIAL_FILES.map((file) => [
    `assets/pay_tutorials/${file}`,
    assetUrl(`./assets/pay_tutorials/${file}`),
  ]),
);
