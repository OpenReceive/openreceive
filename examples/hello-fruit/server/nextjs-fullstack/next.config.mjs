const nextConfig = {
  experimental: {
    externalDir: true
  },
  transpilePackages: [
    "@openreceive/browser",
    "@openreceive/core",
    "@openreceive/express",
    "@openreceive/node",
    "@openreceive/react"
  ]
};

export default nextConfig;
