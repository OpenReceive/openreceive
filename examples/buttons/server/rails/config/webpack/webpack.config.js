const { generateWebpackConfig } = require("shakapacker");

const webpackConfig = generateWebpackConfig();

// Ignore build output so PostCSS dependency watches can't retrigger
// compiles when WebpackAssetsManifest writes public/packs/manifest.json.
webpackConfig.watchOptions = {
  ...webpackConfig.watchOptions,
  ignored: ["**/node_modules/**", "**/public/packs/**", "**/public/packs-test/**", "**/tmp/**"],
};

module.exports = webpackConfig;
