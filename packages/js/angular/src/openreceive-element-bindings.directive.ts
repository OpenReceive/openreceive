import {
  Directive,
  ElementRef,
  Input,
  NgZone,
  inject,
  type OnChanges,
  type OnDestroy,
} from "@angular/core";
import {
  type AppliedElementBindings,
  EMPTY_APPLIED_ELEMENT_BINDINGS,
  type ElementBindings,
  applyElementBindings,
  detachElementListeners,
} from "./element-bindings";

/** Applies a wrapper binding's attributes and listeners to the element host. */
@Directive({
  selector: "[openreceiveElementBindings]",
  standalone: true,
})
export class ElementBindingsDirective implements OnChanges, OnDestroy {
  @Input("openreceiveElementBindings") bindings: ElementBindings = {};

  private applied: AppliedElementBindings = EMPTY_APPLIED_ELEMENT_BINDINGS;
  // Zone-wrapped handlers are cached per original handler: the applier compares
  // identity to decide whether to re-attach, so a fresh wrapper each pass would
  // detach and re-add every listener on every change.
  private readonly zoneWrapped = new WeakMap<(event: Event) => void, (event: Event) => void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  ngOnChanges(): void {
    // Setting attributes restarts the element's poll/countdown timers. Applying them
    // outside Angular keeps those timers unpatched, so they never schedule a change
    // detection pass; the listeners below re-enter the zone for host callbacks.
    this.zone.runOutsideAngular(() => {
      this.applied = applyElementBindings(
        this.host.nativeElement,
        { ...this.bindings, listeners: this.zoneListeners(this.bindings.listeners) },
        this.applied,
      );
    });
  }

  ngOnDestroy(): void {
    detachElementListeners(this.host.nativeElement, this.applied.listeners);
    this.applied = EMPTY_APPLIED_ELEMENT_BINDINGS;
  }

  private zoneListeners(
    listeners: ElementBindings["listeners"],
  ): Readonly<Record<string, ((event: Event) => void) | undefined>> {
    if (listeners === undefined) return {};
    const wrapped: Record<string, ((event: Event) => void) | undefined> = {};
    for (const [name, handler] of Object.entries(listeners)) {
      if (handler === undefined) continue;
      let entry = this.zoneWrapped.get(handler);
      if (entry === undefined) {
        entry = (event: Event) => this.zone.run(() => handler(event));
        this.zoneWrapped.set(handler, entry);
      }
      wrapped[name] = entry;
    }
    return wrapped;
  }
}
