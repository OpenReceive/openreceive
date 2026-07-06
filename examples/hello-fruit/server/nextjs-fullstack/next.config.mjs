import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  experimental: {
    externalDir: true,
  },
  transpilePackages: [
    "@openreceive/browser",
    "@openreceive/core",
    "@openreceive/node",
    "@openreceive/react",
  ],
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@openreceive/browser/styles.css": path.resolve(
        __dirname,
        "../../../../packages/js/browser/src/styles.css",
      ),
    };
    return config;
  },
};

export default nextConfig;
