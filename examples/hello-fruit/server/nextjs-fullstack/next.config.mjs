import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const logLevel = process.env.LOG_LEVEL ?? "INFO";

const nextConfig = {
  experimental: {
    externalDir: true,
  },
  // Non-secret: same LOG_LEVEL for server and browser checkout consoles.
  env: {
    LOG_LEVEL: logLevel,
    NEXT_PUBLIC_LOG_LEVEL: logLevel,
  },
  transpilePackages: [
    "@openreceive/browser",
    "@openreceive/core",
    "@openreceive/node",
    "@openreceive/react",
  ],
  webpack(config) {
    // `@openreceive/react/styles.css` re-imports the browser stylesheet by
    // package specifier. Next's CSS resolver does not read the package export
    // map, so point it at whatever that map names — never at the package source.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@openreceive/browser/styles.css": require.resolve("@openreceive/browser/styles.css"),
    };
    return config;
  },
};

export default nextConfig;
