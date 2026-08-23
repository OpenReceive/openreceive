/**
 * Applying a wrapper binding to a custom element, independent of Angular.
 *
 * Angular templates can only bind attribute names written out literally, so a
 * hand-transcribed `[attr.*]` list silently drops any attribute the shared
 * factory later adds. Driving attributes and listeners from the binding object
 * keeps Angular in step with the other wrappers by construction.
 */

export interface ElementBindings {
  readonly attributes?: Readonly<Record<string, string | undefined>>;
  readonly listeners?: Readonly<Record<string, ((event: Event) => void) | undefined>>;
}

export interface ElementBindingTarget {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(name: string, listener: (event: Event) => void): void;
  removeEventListener(name: string, listener: (event: Event) => void): void;
}

export type AttachedListeners = readonly (readonly [string, (event: Event) => void])[];

export interface AppliedElementBindings {
  readonly attributes: readonly string[];
  readonly listeners: AttachedListeners;
}

export const EMPTY_APPLIED_ELEMENT_BINDINGS: AppliedElementBindings = {
  attributes: [],
  listeners: [],
};

export function applyElementBindings(
  element: ElementBindingTarget,
  bindings: ElementBindings,
  applied: AppliedElementBindings,
): AppliedElementBindings {
  return {
    attributes: syncAttributes(element, bindings.attributes ?? {}, applied.attributes),
    listeners: syncListeners(element, bindings.listeners ?? {}, applied.listeners),
  };
}

export function detachElementListeners(
  element: ElementBindingTarget,
  listeners: AttachedListeners,
): void {
  for (const [name, handler] of listeners) element.removeEventListener(name, handler);
}

function syncAttributes(
  element: ElementBindingTarget,
  attributes: Readonly<Record<string, string | undefined>>,
  applied: readonly string[],
): readonly string[] {
  for (const name of applied) {
    if (attributes[name] === undefined) element.removeAttribute(name);
  }
  const next: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    next.push(name);
  }
  return next;
}

function syncListeners(
  element: ElementBindingTarget,
  listeners: Readonly<Record<string, ((event: Event) => void) | undefined>>,
  attached: AttachedListeners,
): AttachedListeners {
  const next = Object.entries(listeners).flatMap(([name, handler]) =>
    handler === undefined ? [] : [[name, handler] as const],
  );
  const unchanged =
    next.length === attached.length &&
    next.every(([name, handler], index) => {
      const current = attached[index];
      return current !== undefined && current[0] === name && current[1] === handler;
    });
  if (unchanged) return attached;
  detachElementListeners(element, attached);
  for (const [name, handler] of next) element.addEventListener(name, handler);
  return next;
}
