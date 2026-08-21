const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const { generateWebpackConfig } = require("shakapacker");
const webpack = require("webpack");

const repoRoot = path.resolve(__dirname, "../../../../../..");

const webpackConfig = generateWebpackConfig();

// Ignore build output so Tailwind/PostCSS dependency watches can't retrigger
// compiles when WebpackAssetsManifest writes public/packs/manifest.json.
webpackConfig.watchOptions = {
  ...webpackConfig.watchOptions,
  ignored: ["**/node_modules/**", "**/public/packs/**", "**/public/packs-test/**", "**/tmp/**"],
};

// shared/demo-browser-logging.ts reads import.meta.env.LOG_LEVEL (a Vite-ism
// kept for parity with the other Hello Fruit demos).
webpackConfig.plugins.push(
  new webpack.DefinePlugin({
    "import.meta.env.LOG_LEVEL": JSON.stringify(process.env.LOG_LEVEL ?? "INFO"),
  }),
  // Provider icons and pay-tutorial images resolve at runtime via
  // `new URL("./assets/…", import.meta.url)` inside the packaged JS, which
  // lands next to the emitted chunk (/packs/js/…). Copy them there — the same
  // job the Vite demos do with copy-openreceive-payment-icons-plugin.
  new CopyPlugin({
    patterns: [
      {
        from: path.join(repoRoot, "packages/js/browser/dist/assets/icons"),
        to: "js/assets/icons",
      },
      {
        from: path.join(repoRoot, "packages/js/provider-data/dist/assets/provider-icons"),
        to: "js/assets/provider-icons",
      },
      {
        from: path.join(repoRoot, "packages/js/provider-data/dist/assets/pay_tutorials"),
        to: "js/assets/pay_tutorials",
      },
    ],
  }),
);

module.exports = webpackConfig;
