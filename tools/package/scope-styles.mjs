// Scope the compiled Tailwind + daisyUI sheet to OpenReceive-rendered subtrees.
//
// The one Tailwind compile in build-browser-css.mjs is global by construction:
// preflight resets on `*` / `h1` / `img` / `button`, `:root` custom-property
// dumps, and daisyUI components under their generic names (`.btn`, `.card`,
// `.modal`). Inside a shadow root that is exactly right — the boundary is the
// scope. Shipped as a FILE and imported into a host page it restyles the host:
// a Mantine SegmentedControl lost its label padding to the `*{padding:0}`
// reset (declared in a later @layer, it beat Mantine's regardless of
// specificity), and a Bootstrap page would have its `.btn` repainted.
//
// This pass rewrites every selector so the sheet is inert outside an element
// carrying `data-openreceive-root` — the marker every light-DOM entry stamps
// (React `<Checkout>` / `<ThemeToggle>`, the Vue/Svelte/Angular shell). It is a
// postcss AST pass, never a regex over minified CSS, and the rules are:
//
//   R := :where([data-openreceive-root])      zero specificity, so a rule's own
//                                             specificity is all that survives
//   S (not root-anchored)  → R:is(S), R :is(S)
//       self form so a rule aimed at the root element itself still applies
//       (`*` includes the root; daisyUI's `[data-theme=dark]` is stamped ON
//       the root), descendant form for everything inside. S's specificity
//       rides along inside :is(); a trailing pseudo-element stays outside it.
//   S starting with html / body / :root → R + the rest of S, self form ONLY
//       the root plays the document element's part. No descendant form: the
//       light `:root{--color-*}` dump on every descendant would override the
//       dark palette a `[data-theme=dark]` root's children inherit.
//   S starting with :host → dropped
//       unmatchable in light DOM today, so dropping it changes nothing.
//   S already carrying a data-openreceive-* attribute → untouched
//   @keyframes selectors (`from`, `to`, `50%`) → untouched
//
// The shadow-DOM copy (src/generated/compiled-styles.ts) is NOT passed through
// here: inside a shadow root the unscoped preflight is wanted.
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

/** Mirrors OPENRECEIVE_STYLE_ROOT_ATTRIBUTE in browser/src/internal/dom-contract.ts (pinned by tests/scope-styles.test.mjs). */
export const STYLE_ROOT_ATTRIBUTE = "data-openreceive-root";
const SCOPE = `:where([${STYLE_ROOT_ATTRIBUTE}])`;
const ROOT_TAGS = new Set(["html", "body"]);
const LEGACY_PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

function isPseudoElement(node) {
  return (
    node.type === "pseudo" &&
    (node.value.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(node.value.toLowerCase()))
  );
}

function isRootNode(node) {
  if (node.type === "tag") return ROOT_TAGS.has(node.value.toLowerCase());
  return node.type === "pseudo" && node.value.toLowerCase() === ":root";
}

function isHostNode(node) {
  return node.type === "pseudo" && node.value.toLowerCase().startsWith(":host");
}

function carriesMarker(selector) {
  let marked = false;
  selector.walkAttributes((attribute) => {
    if (attribute.attribute.startsWith("data-openreceive-")) marked = true;
  });
  return marked;
}

function join(nodes) {
  return nodes.map((node) => node.toString()).join("");
}

/** A selector that is nothing but the document root: `:root`, `html`, `body`. */
function isRootOnlySelector(selector) {
  return selector.nodes.length > 0 && selector.nodes.every(isRootNode);
}

/**
 * daisyUI wraps the root in a forgiving list — `:where(:root)`,
 * `:where(:root,[data-theme])` — so the root entry is not a top-level node.
 * Pull it out: the root part becomes the plain root-anchored form, and the
 * list minus its root entries goes back through the ordinary rewrite (both
 * forms, its own specificity). Returns null when the leading compound has no
 * such list.
 */
function splitRootFromLeadingList(selector) {
  const firstCombinator = selector.nodes.findIndex((node) => node.type === "combinator");
  const leading =
    firstCombinator === -1 ? selector.nodes : selector.nodes.slice(0, firstCombinator);
  const list = leading.find(
    (node) =>
      node.type === "pseudo" &&
      [":where", ":is"].includes(node.value.toLowerCase()) &&
      node.nodes.some(isRootOnlySelector),
  );
  if (list === undefined) return null;
  const rootForm = selector.clone();
  const remainder = selector.clone();
  const remainderList = remainder.nodes[leading.indexOf(list)];
  for (const inner of [...remainderList.nodes]) if (isRootOnlySelector(inner)) inner.remove();
  if (remainderList.nodes.length === 0) remainderList.remove();
  const rootFormList = rootForm.nodes[leading.indexOf(list)];
  rootFormList.replaceWith(selectorParser.pseudo({ value: ":root" }));
  return { rootForm, remainder: remainder.nodes.length === 0 ? null : remainder };
}

/**
 * Rewrite ONE complex selector (already parsed) into its scoped forms.
 * Returns [] for a selector that must be dropped.
 */
function scopeComplexSelector(selector) {
  if (carriesMarker(selector)) return [selector.toString().trim()];
  const nodes = selector.nodes;
  if (nodes.some(isHostNode)) return [];
  const split = splitRootFromLeadingList(selector);
  if (split !== null) {
    return [
      ...scopeComplexSelector(split.rootForm),
      ...(split.remainder === null ? [] : scopeComplexSelector(split.remainder)),
    ];
  }

  // Split off the trailing pseudo-element (and anything after it in the last
  // compound): `::placeholder` cannot live inside :is().
  const firstCombinator = nodes.findIndex((node) => node.type === "combinator");
  const lastCombinator = nodes.findLastIndex((node) => node.type === "combinator");
  const tailStart = nodes.findIndex(
    (node, index) => index > lastCombinator && isPseudoElement(node),
  );
  const body = tailStart === -1 ? nodes : nodes.slice(0, tailStart);
  const tail = tailStart === -1 ? "" : join(nodes.slice(tailStart));
  // `li+:before` is `li+*:before` with the universal selector implied; once
  // the pseudo-element is split off, the implied `*` must be spelled out or
  // the combinator dangles inside :is() and the browser drops the selector.
  const implicitUniversal =
    tail !== "" && body.length > 0 && body[body.length - 1].type === "combinator" ? "*" : "";

  const firstCompoundEnd = firstCombinator === -1 ? body.length : firstCombinator;
  const firstCompound = body.slice(0, firstCompoundEnd);
  const rest = body.slice(firstCompoundEnd);
  if (rest.some(isRootNode)) {
    throw new Error(`scope-styles: root selector in a non-leading compound: ${selector}`);
  }

  if (firstCompound.some(isRootNode)) {
    const kept = join(
      firstCompound.filter((node) => !isRootNode(node) && node.type !== "universal"),
    );
    return [`${SCOPE}${kept === "" ? "" : `:is(${kept})`}${join(rest)}${implicitUniversal}${tail}`];
  }

  const base = `${join(body)}${implicitUniversal}`.trim();
  if (base === "" || base === "*") return [`${SCOPE}${tail}`, `${SCOPE} *${tail}`];
  return [`${SCOPE}:is(${base})${tail}`, `${SCOPE} :is(${base})${tail}`];
}

function insideKeyframes(rule) {
  for (let node = rule.parent; node !== undefined && node.type !== "root"; node = node.parent) {
    if (node.type === "atrule" && /keyframes$/i.test(node.name)) return true;
  }
  return false;
}

/** Scope every selector of a rule; returns the new selector list (may be empty). */
export function scopeSelectorList(selectorList) {
  const scoped = [];
  selectorParser((root) => {
    for (const selector of root.nodes) scoped.push(...scopeComplexSelector(selector));
  }).processSync(selectorList);
  return scoped;
}

/** Scope a whole stylesheet; every rule under every @layer/@media/@supports/@container. */
export function scopeStyles(css) {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    const selectors = scopeSelectorList(rule.selector);
    if (selectors.length === 0) {
      rule.remove();
      return;
    }
    rule.selectors = selectors;
  });
  return root.toString();
}
