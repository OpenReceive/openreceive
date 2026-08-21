import { openReceiveCheckoutElementStyles } from "@openreceive/browser/internal";

/** Inline stylesheet for shadow roots that cannot adopt a constructable sheet. */
export const openReceiveCheckoutStyleTag = `<style>${openReceiveCheckoutElementStyles}</style>`;

// One constructable sheet per document: a sheet belongs to the document that
// built it and cannot be adopted by another (iframes, print documents).
const sheetsByDocument = new WeakMap<Document, CSSStyleSheet>();

/**
 * Adopt the compiled checkout stylesheet into `root`.
 *
 * The stylesheet is ~100KB. Inlining it in the markup means the browser reparses
 * all of it on every render — once per poll tick, per element, and once more for
 * a theme toggle that uses one button's worth of it. Adopting one shared sheet
 * parses it once per document and survives `innerHTML` writes.
 *
 * Returns false when constructable stylesheets are unavailable; callers then
 * inline {@link openReceiveCheckoutStyleTag} instead.
 */
export function adoptOpenReceiveCheckoutStyles(root: ShadowRoot): boolean {
  const ownerDocument = root.ownerDocument as Document | null;
  if (ownerDocument === null) return false;
  const view = ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const SheetConstructor = view?.CSSStyleSheet ?? globalThis.CSSStyleSheet;
  if (SheetConstructor === undefined || !Array.isArray(root.adoptedStyleSheets)) return false;

  let sheet = sheetsByDocument.get(ownerDocument);
  if (sheet === undefined) {
    try {
      const created = new SheetConstructor();
      if (typeof created.replaceSync !== "function") return false;
      created.replaceSync(openReceiveCheckoutElementStyles);
      sheet = created;
    } catch {
      // Older engines reject `new CSSStyleSheet()` outright.
      return false;
    }
    sheetsByDocument.set(ownerDocument, sheet);
  }

  if (!root.adoptedStyleSheets.includes(sheet)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
  return true;
}
