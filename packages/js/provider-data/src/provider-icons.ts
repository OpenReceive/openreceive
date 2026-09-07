// The wallet logos ship inside the JavaScript as `data:image/webp;base64` URIs
// (see tools/package/generate-provider-images.mjs): nothing here depends on
// where the module was loaded from, and no host copies, serves or resolves an
// image file. Eager, in the main bundle — the provider grid draws every logo
// the moment it renders.
import { providerIconImages } from "./generated/provider-icon-images.ts";

/** Each wallet logo as a `data:` URI, keyed by the registry `icon_path`. */
export const providerIconUrls: Readonly<Record<string, string>> = providerIconImages;
