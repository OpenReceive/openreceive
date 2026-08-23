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

// The packaged UI resolves its images at runtime against `import.meta.url`:
// `new URL("./assets/icons/btc.svg", import.meta.url)` in @openreceive/browser,
// `./assets/provider-icons/…` and `./assets/pay_tutorials/…` in
// @openreceive/provider-data. Webpack's default is to freeze `import.meta.url`
// into the build machine's file:// path of the source module, which no browser
// can load. So the pack defines it as the URL of the <script> that is running
// instead: every package module is evaluated synchronously inside the pack's
// own script (hmr is off), so that is the pack's URL, and the images resolve
// beside it under /packs/js/assets/… — where CopyPlugin puts them. The Vite
// demos do the same copy with copy-openreceive-payment-icons-plugin; Vite
// resolves `import.meta.url` on its own.
webpackConfig.module.parser = {
  ...webpackConfig.module.parser,
  javascript: { ...webpackConfig.module.parser?.javascript, importMeta: false },
};
webpackConfig.plugins.push(
  new webpack.DefinePlugin({
    // shared/demo-browser-logging.ts reads import.meta.env.LOG_LEVEL (a Vite-ism
    // kept for parity with the other Hello Fruit demos).
    "import.meta.env.LOG_LEVEL": JSON.stringify(process.env.LOG_LEVEL ?? "INFO"),
    "import.meta.url": "((document.currentScript && document.currentScript.src) || location.href)",
  }),
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
