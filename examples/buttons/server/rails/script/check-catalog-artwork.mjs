// examples/buttons/shared/shop-catalog.json is the seed source of truth for
// every stack. Every row names an artwork file, and that file has to exist in
// the ONE images directory all four stacks read.
//
// Nothing else notices when the two disagree: a missing file is a broken
// thumbnail in the catalog and a 404 on a download somebody has already paid
// for. This is the check that fails loudly instead.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sharedRoot = resolve(here, "../../../shared");
const imagesRoot = resolve(here, "../../../images");

const catalogPath = join(sharedRoot, "shop-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const failures = [];

if (!Array.isArray(catalog) || catalog.length === 0) {
  failures.push(`${catalogPath} is not a non-empty array.`);
}

const seenSkus = new Set();
const seenImages = new Set();

for (const entry of catalog) {
  const { sku, name, price_cents: priceCents, position, image_name: imageName } = entry ?? {};

  if (typeof sku !== "string" || !/^[a-z]+(?:-[a-z]+)*$/.test(sku)) {
    failures.push(`Bad sku: ${JSON.stringify(sku)}`);
    continue;
  }
  if (seenSkus.has(sku)) failures.push(`Duplicate sku: ${sku}`);
  seenSkus.add(sku);

  if (typeof name !== "string" || name.length === 0) failures.push(`${sku}: missing name`);
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    failures.push(`${sku}: price_cents must be a positive integer, got ${priceCents}`);
  }
  if (!Number.isInteger(position)) failures.push(`${sku}: position must be an integer`);

  if (typeof imageName !== "string" || imageName.length === 0) {
    failures.push(`${sku}: missing image_name`);
    continue;
  }
  // Two products on one photo means a download that is not what the thumbnail
  // showed. The column exists so the filename CAN differ from the sku, not so
  // it can be shared.
  if (seenImages.has(imageName)) failures.push(`${sku}: image_name ${imageName} is used twice`);
  seenImages.add(imageName);

  if (!existsSync(join(imagesRoot, imageName))) {
    failures.push(`${sku}: ${imageName} is not in examples/buttons/images/`);
  }
}

if (failures.length > 0) {
  console.error("Catalog/artwork check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const available = readdirSync(imagesRoot).filter((file) => file.endsWith(".webp"));
console.log(
  `Catalog/artwork check passed: ${catalog.length} products, ` +
    `${available.length} webp files in examples/buttons/images/.`,
);
