import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const RUNTIME_ASSET_DIRS = [
  {
    src: ["packages", "js", "browser", "dist", "assets", "icons"],
    dest: ["assets", "icons"],
    missing: "run npm run build -w @openreceive/browser first.",
  },
  {
    src: ["packages", "js", "provider-data", "dist", "assets", "provider-icons"],
    dest: ["assets", "provider-icons"],
    missing: "run npm run build -w @openreceive/provider-data first.",
  },
  {
    src: ["packages", "js", "provider-data", "dist", "assets", "pay_tutorials"],
    dest: ["assets", "pay_tutorials"],
    missing: "run npm run build -w @openreceive/provider-data first.",
  },
] as const;

/**
 * Copy OpenReceive runtime images next to the Vite JS chunk so
 * `new URL("./icons/…", import.meta.url)` and rewritten provider-data
 * `./provider-icons/…` / `./pay_tutorials/…` paths from `/assets/*.js` resolve.
 */
export function copyOpenReceivePaymentIconsPlugin(
  repoRoot: string,
  options: { readonly destRoot?: string } = {},
): Plugin {
  return {
    name: "copy-openreceive-payment-icons",
    writeBundle(writeOptions) {
      const outDir = options.destRoot ?? writeOptions.dir;
      if (outDir === undefined) return;

      for (const assetDir of RUNTIME_ASSET_DIRS) {
        const src = path.join(repoRoot, ...assetDir.src);
        if (!existsSync(src)) {
          this.warn(`OpenReceive assets missing at ${src}; ${assetDir.missing}`);
          continue;
        }
        const dest = path.join(outDir, ...assetDir.dest);
        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true });
      }
    },
  };
}
