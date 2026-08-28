const logLevel = process.env.LOG_LEVEL ?? "INFO";

const nextConfig = {
  // The shop UI, the wire types, the Node store and the artwork all live above
  // this directory, in examples/buttons/shared and examples/buttons/images.
  // One copy, four readers.
  experimental: { externalDir: true },
  // Next 16 writes AGENTS.md and CLAUDE.md into the demo on every boot. This
  // repo's agent instructions are its own; a generated pair here would be two
  // more files to explain and one more thing to keep out of the diff.
  agentRules: false,
  // Non-secret: the same LOG_LEVEL for the server and the browser checkout.
  env: { LOG_LEVEL: logLevel, NEXT_PUBLIC_LOG_LEVEL: logLevel },
  transpilePackages: [
    "@openreceive/browser",
    "@openreceive/core",
    "@openreceive/node",
    "@openreceive/react",
  ],
};

export default nextConfig;
