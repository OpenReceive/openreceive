/**
 * Make happy-dom upgrade custom elements in a browser's order.
 *
 * When `customElements.define` finds an element of that name already in the
 * document, a browser upgrades it (HTML "upgrade an element"): it runs the
 * constructor, calls `attributeChangedCallback(name, null, value)` once per
 * observed attribute already present, in attribute order and while the element
 * is connected, then calls `connectedCallback`. happy-dom 21 calls only
 * `connectedCallback`, so a test that puts markup on the page before defining
 * the element never runs the attribute callbacks a browser would. Issue #137
 * lived in exactly that gap: the element prepared once per identity attribute.
 *
 * Install before the element is defined. Definitions made afterwards replay
 * the missing callbacks before the upgrade's `connectedCallback`. An attribute
 * that already reached `attributeChangedCallback` is never replayed, so this
 * does nothing once happy-dom follows the spec.
 *
 * Covers elements in the document itself at define time (server-rendered
 * markup, a module script, a wrapper that defines on mount); not elements
 * inside shadow roots, and not innerHTML after define. The real-browser spec
 * `tests/e2e/element-mounts.spec.ts` covers those.
 */
export function installBrowserUpgradeOrder() {
  const registry = globalThis.customElements;
  const define = registry.define.bind(registry);
  registry.define = (name, elementClass, options) => {
    const prototype = elementClass.prototype;
    const observed = new Set(elementClass.observedAttributes ?? []);
    const seen = new WeakMap();
    const awaitingUpgrade = new WeakSet(document.querySelectorAll(name));
    const attributeChanged = prototype.attributeChangedCallback;
    const connected = prototype.connectedCallback;
    if (typeof attributeChanged === "function") {
      prototype.attributeChangedCallback = function (attribute, oldValue, newValue) {
        let names = seen.get(this);
        if (names === undefined) {
          names = new Set();
          seen.set(this, names);
        }
        names.add(attribute);
        return attributeChanged.call(this, attribute, oldValue, newValue);
      };
    }
    prototype.connectedCallback = function () {
      if (awaitingUpgrade.has(this)) {
        awaitingUpgrade.delete(this);
        for (const { name: attribute, value } of [...this.attributes]) {
          if (!observed.has(attribute) || seen.get(this)?.has(attribute)) continue;
          prototype.attributeChangedCallback?.call(this, attribute, null, value);
        }
      }
      return connected?.call(this);
    };
    return define(name, elementClass, options);
  };
}
