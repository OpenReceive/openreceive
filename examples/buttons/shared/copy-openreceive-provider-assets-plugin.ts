import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// Only @openreceive/provider-data's images. The payment-method icons in
// @openreceive/browser are compiled into its JavaScript and need no copying.
const RUNTIME_ASSET_DIRS = [
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
 * Copy OpenReceive's provider images next to the Vite JS chunk so the
 * rewritten provider-data `./provider-icons/…` / `./pay_tutorials/…` paths
 * resolve from `/assets/*.js`.
 */
export function copyProviderAssetsPlugin(
  repoRoot: string,
  options: { readonly destRoot?: string } = {},
): Plugin {
  return {
    name: "copy-openreceive-provider-assets",
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
