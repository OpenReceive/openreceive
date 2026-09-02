// Webpack freezes `import.meta.url` into the build machine's file:// path of
// the source module, so @openreceive/provider-data's runtime image resolution
// — `new URL("./assets/provider-icons/…", import.meta.url)` and
// `./assets/pay_tutorials/…` — would point at files no browser can load. (The
// payment-method icons in @openreceive/browser are compiled into its
// JavaScript and never touch this.)
//
// This loader rewrites that one expression, in that package only, to the URL
// of the <script> that is running. Every package module is evaluated
// synchronously inside the pack's own script (hmr is off), so that is the
// pack's URL, and the images resolve beside it under /packs/js/assets/… — where
// webpack.config.js's CopyPlugin puts them. The Vite demos copy the same files
// with copy-openreceive-provider-assets-plugin; Vite resolves `import.meta.url`
// on its own.
const RUNNING_SCRIPT_URL = "(document.currentScript ? document.currentScript.src : location.href)";

module.exports = function importMetaUrlLoader(source) {
  return source.replaceAll("import.meta.url", RUNNING_SCRIPT_URL);
};
