// Webpack freezes `import.meta.url` into the build machine's file:// path of
// the source module, so the OpenReceive packages' runtime image resolution —
// `new URL("./assets/icons/btc.svg", import.meta.url)` in @openreceive/browser,
// `./assets/provider-icons/…` and `./assets/pay_tutorials/…` in
// @openreceive/provider-data — would point at files no browser can load.
//
// This loader rewrites that one expression, in those packages only, to the URL
// of the <script> that is running. Every package module is evaluated
// synchronously inside the pack's own script (hmr is off), so that is the
// pack's URL, and the images resolve beside it under /packs/js/assets/… — where
// webpack.config.js's CopyPlugin puts them. The Vite demos copy the same files
// with copy-openreceive-payment-icons-plugin; Vite resolves `import.meta.url`
// on its own.
const RUNNING_SCRIPT_URL =
  "(document.currentScript ? document.currentScript.src : location.href)";

module.exports = function openReceiveImportMetaUrlLoader(source) {
  return source.replaceAll("import.meta.url", RUNNING_SCRIPT_URL);
};
