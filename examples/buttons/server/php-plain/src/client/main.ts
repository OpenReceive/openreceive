/**
 * The browser entry: the SAME no-framework shop the static-html-small-api demo
 * runs (`examples/buttons/shared/client-vanilla/main.ts`), unchanged, against
 * a PHP server instead of a Node one.
 *
 * The one thing this stack does differently is where `@openreceive/elements`
 * comes from. vite.config.ts points that import at the STANDALONE checkout
 * build — `public/openreceive/openreceive-checkout.js`, the file a plain-PHP
 * host unpacks from the release's `standalone-checkout-<version>.tar.gz` — so
 * the payment step here is the bundler-less artefact, not an npm dependency
 * bundled by Vite. Its stylesheet is linked from index.html and served by PHP.
 *
 * The shop's own stylesheet still comes through Vite: it is this demo's design,
 * not OpenReceive's.
 */

import "../../../../shared/shop.css";
import "../../../../shared/client-vanilla/shop-vanilla.css";
import "../../../../shared/client-vanilla/main.ts";
