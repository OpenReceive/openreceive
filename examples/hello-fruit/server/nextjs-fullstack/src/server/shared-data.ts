import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface HelloFruitProduct {
  readonly schema_version: string;
  readonly product_id: string;
  readonly name: string;
  readonly description: string;
}

export interface HelloFruit {
  readonly id: string;
  readonly name: string;
  readonly sticker: string;
  readonly fiat: {
    readonly currency: string;
    readonly value: string;
  };
}

export interface HelloFruitList {
  readonly schema_version: string;
  readonly product_id: string;
  readonly fruits: readonly HelloFruit[];
}

const sharedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../shared");

export function readHelloFruitProduct(): HelloFruitProduct {
  return readJson("product.json") as HelloFruitProduct;
}

export function readHelloFruits(): HelloFruitList {
  return readJson("fruits.json") as HelloFruitList;
}

export function helloFruitSharedFile(pathname: string): string {
  return path.join(sharedRoot, pathname);
}

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(path.join(sharedRoot, filename), "utf8"));
}
