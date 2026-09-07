// The pay-tutorial screenshots ship inside the JavaScript too, but they are
// the one image set a checkout does not draw on first paint (~270 KB of
// base64 nobody sees until a tutorial opens), so they live behind a dynamic
// import(). Code-splitting hosts fetch a separate JavaScript chunk on first
// tutorial open; single-file builds include the same data in their main bundle.

type PayTutorialImages = Readonly<Record<string, string>>;

let cached: PayTutorialImages | undefined;
let loading: Promise<PayTutorialImages> | undefined;

/**
 * Load the tutorial images. Memoised: the module is loaded once per page and
 * every later call answers the same promise. A rejection propagates — callers
 * treat it as "no image" and render the caption alone.
 */
export function loadPayTutorialImages(): Promise<PayTutorialImages> {
  loading ??= import("./generated/pay-tutorial-images.ts").then((module) => {
    cached = module.payTutorialImages;
    return cached;
  });
  return loading;
}

/**
 * The `data:` URI for one tutorial `path`, synchronously, from the cache
 * {@link loadPayTutorialImages} fills. `undefined` until that promise has
 * resolved — a renderer draws the caption without an `<img>` in the meantime.
 */
export function payTutorialImage(path: string): string | undefined {
  return cached?.[path];
}
