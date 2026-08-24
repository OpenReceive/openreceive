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
};

export default nextConfig;
