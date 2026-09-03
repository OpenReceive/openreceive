// The React create-mode pre-create screens carry the resolved theme. The
// creating placeholder is server-renderable and pinned in
// react-checkout-ui.test.mjs; the "Could not start checkout." screen only
// exists after a failed prepare, so it needs a DOM and an effect.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://harness.local/" });

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Checkout, ThemeScope } = await import("../packages/js/react/src/index.ts");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function mountFailingCreate(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const createFetch = () =>
    Promise.reject(new Error("Exchange rates are temporarily unavailable."));
  await act(async () => {
    root.render(
      React.createElement(Checkout, {
        reference: "ord-1",
        createFetch,
        onError: () => {},
        ...props,
      }),
    );
  });
  // Let the rejected prepare land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const section = container.querySelector("section.openreceive-checkout-error");
  assert.ok(section, `expected the error screen, got: ${container.innerHTML}`);
  return { container, section, unmount: () => act(() => root.unmount()) };
}

test("the create-error screen carries the locked theme and the checkout root", async () => {
  const { section, unmount } = await mountFailingCreate({ theme: "dark" });
  assert.equal(section.getAttribute("data-theme"), "dark");
  assert.equal(section.getAttribute("data-openreceive-theme"), "dark");
  assert.equal(section.getAttribute("data-openreceive-root"), "");
  assert.equal(section.getAttribute("data-openreceive-checkout"), "");
  // The surface pads itself; the notice sits inside it.
  assert.match(section.className, /\bp-4\b/);
  assert.match(section.className, /\brounded-box\b/);
  assert.match(section.textContent, /Could not start checkout\./);
  assert.match(section.textContent, /Exchange rates are temporarily unavailable\./);
  await unmount();
});

test("the create-error screen mirrors an ancestor ThemeScope's resolved theme", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        ThemeScope,
        { theme: "dark" },
        React.createElement(Checkout, {
          reference: "ord-2",
          createFetch: () => Promise.reject(new Error("nope")),
          onError: () => {},
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const section = container.querySelector("section.openreceive-checkout-error");
  assert.ok(section);
  // Under a scope the scope owns `data-openreceive-theme`; the checkout still
  // mirrors the resolved palette on its own root, because the scoped
  // stylesheet paints from there.
  assert.equal(section.getAttribute("data-theme"), "dark");
  assert.equal(section.getAttribute("data-openreceive-theme"), null);
  await act(() => root.unmount());
});
