const nextConfig = {
  experimental: {
    externalDir: true
  },
  transpilePackages: [
    "@openreceive/browser",
    "@openreceive/core",
    "@openreceive/node",
    "@openreceive/react"
  ]
};

export default nextConfig;
