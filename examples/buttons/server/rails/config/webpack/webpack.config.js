const path = require("node:path");
const CopyPlugin = require("copy-webpack-plugin");
const { generateWebpackConfig } = require("shakapacker");

const repoRoot = path.resolve(__dirname, "../../../../../..");

const webpackConfig = generateWebpackConfig();

// Ignore build output so PostCSS dependency watches can't retrigger
// compiles when WebpackAssetsManifest writes public/packs/manifest.json.
webpackConfig.watchOptions = {
  ...webpackConfig.watchOptions,
  ignored: ["**/node_modules/**", "**/public/packs/**", "**/public/packs-test/**", "**/tmp/**"],
};

// @openreceive/provider-data's images (provider logos, pay tutorials) resolve
// against `import.meta.url`; see the loader for why webpack needs help with
// that, and CopyPlugin below for where the images have to be for the rewritten
// URL to find them. The payment-method icons in @openreceive/browser are
// compiled into its JavaScript and need neither.
webpackConfig.module.rules.push({
  test: /(?:[\\/]packages[\\/]js|[\\/]@openreceive)[\\/]provider-data[\\/]dist[\\/].*\.js$/,
  loader: path.join(__dirname, "openreceive-import-meta-url-loader.js"),
});

webpackConfig.plugins.push(
  // Provider icons and pay-tutorial images, next to the emitted chunk
  // (/packs/js/…) — the same job the Vite demos do with
  // copy-openreceive-provider-assets-plugin. This is what makes the URLs the
  // loader above rewrites actually resolve, which is in turn why
  // shared/client/components/MethodGrid.tsx can call the icon getters with no
  // asset resolver at all.
  new CopyPlugin({
    patterns: [
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
