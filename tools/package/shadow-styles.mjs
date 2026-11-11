// The sheet the custom elements adopt in their shadow roots.
//
// Tailwind v4 gives `border`, `shadow`, `ring`, gradients and transforms
// their starting values through `@property` rules (`--tw-border-style` starts
// as `solid`, and `.border` reads it). A browser ignores `@property` inside a
// shadow root, so in the element those variables had no value: every `.border`
// drew no border on an ordinary page, and the borders appeared only on a host
// that ran Tailwind v4 itself, whose document-level `@property` rules reached
// in. Tailwind ships its own fallback for engines without `@property`, which
// sets the same starting values on every element, behind an `@supports` only
// those old engines match. Inside a shadow root that fallback is always
// needed, so this pass drops the condition and keeps the block.
//
// A postcss AST pass, like scope-styles.mjs, never a regex over minified CSS.

import postcss from "postcss";

export function shadowStyles(css) {
  const root = postcss.parse(css);
  let unwrapped = 0;
  root.walkAtRules("layer", (layer) => {
    if (layer.params !== "properties") return;
    layer.walkAtRules("supports", (supports) => {
      supports.replaceWith(supports.nodes);
      unwrapped += 1;
    });
  });
  if (unwrapped !== 1) {
    throw new Error(
      `shadow-styles: expected Tailwind's one @supports fallback inside @layer properties, found ${unwrapped}; check the Tailwind output`,
    );
  }
  return root.toString();
}
