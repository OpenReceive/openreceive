import {
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  Input,
  NgZone,
  inject,
  type AfterViewInit,
  type OnChanges,
} from "@angular/core";
import {
  type CheckoutSnapshot,
  type ThemePreference,
  type WrapperCheckoutShellBinding,
  type WrapperCheckoutShellOptions,
  createWrapperCheckoutShellBinding,
  defineElements,
  validateCheckoutProps,
} from "@openreceive/angular";
import type { ElementBindings } from "./element-bindings";
import { ElementBindingsDirective } from "./openreceive-element-bindings.directive";

@Component({
  selector: "openreceive-angular-checkout",
  standalone: true,
  imports: [ElementBindingsDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <section [openreceiveElementBindings]="rootBindings">
      @if (elementsReady && shell; as shell) {
        @if (shell.themeToggle) {
          <openreceive-theme-toggle
            [openreceiveElementBindings]="shell.themeToggle"
          ></openreceive-theme-toggle>
        }
        <openreceive-checkout [openreceiveElementBindings]="shell.checkout"></openreceive-checkout>
      }
    </section>
  `,
})
export class CheckoutComponent implements AfterViewInit, OnChanges {
  // Prop names, defaults, and per-mode applicability are the shared contract in
  // docs/internal/wrapper-parity.md. These inputs RESTATE it because `@Input()`
  // is a decorator on a declared field: a type cannot generate fields, so they
  // cannot be derived from WrapperCheckoutComponentProps the way
  // Vue's defineProps and React's CheckoutProps are. The duplication is forced,
  // not neglected; tests/wrapper-parity.test.mjs is what keeps it in step.
  // Snapshot mode: bind a `checkout` to render it directly.
  // Create mode: omit `checkout` and bind `reference` (+ optional `prefix`); the underlying
  // <openreceive-checkout> element creates the checkout, then renders and polls itself.
  @Input() checkout?: CheckoutSnapshot | null;
  @Input() reference?: string;
  @Input() prefix?: string;
  @Input() paymentWizard?: boolean;
  @Input() decodeLinkUrl?: string;
  @Input() assetBaseUrl?: string;
  @Input() themeToggle?: boolean;
  @Input() defaultTheme?: ThemePreference;
  @Input() storageKey?: string;
  // Create mode only.
  @Input() metadata?: Record<string, unknown>;
  @Input() syncUrl?: boolean;
  @Input() resumePathPrefix?: string;
  @Input() routeReference?: string;
  @Input() onCopy?: (event: Event) => void;
  @Input() onOpenWallet?: (event: Event) => void;
  @Input() onState?: (event: Event) => void;
  @Input() onSettled?: (event: Event) => void;
  @Input() onProviderCopy?: (event: Event) => void;
  @Input() onStartOver?: (event: Event) => void;
  @Input() onError?: (event: Event) => void;
  @Input() options: WrapperCheckoutShellOptions = {};

  /**
   * The custom elements render only once this flips, and it flips inside
   * `runOutsideAngular`: the element starts poll and countdown timers in its
   * connected callback, and zone-patched timers would schedule a change-detection
   * pass on every tick for the lifetime of the checkout.
   */
  protected elementsReady = false;

  private readonly zone = inject(NgZone);
  private readonly changeDetector = inject(ChangeDetectorRef);

  // Rebuilt on input changes only. A getter would rebuild the whole binding
  // (storage reads, matchMedia, fresh objects) on every change-detection pass.
  // Null until the first `ngOnChanges`: inputs are not set yet at construction,
  // so building (and validating) here would reject every instantiation.
  protected shellBinding: WrapperCheckoutShellBinding | null = null;

  // The shell root's attributes, driven by the same directive as the custom
  // elements: a hand-transcribed [attr.*] list would silently drop any root
  // attribute the shared factory later adds.
  protected rootBindings: ElementBindings = {};

  ngAfterViewInit(): void {
    // No-op during Angular Universal SSR: custom elements only exist in the
    // browser, and the element renders itself after hydration.
    if (globalThis.customElements === undefined || globalThis.HTMLElement === undefined) return;
    this.zone.runOutsideAngular(() => {
      defineElements();
      this.elementsReady = true;
      // Rebuild so the mounted shell carries the stored theme, not the deferred default.
      this.applyShell();
      this.changeDetector.detectChanges();
    });
  }

  ngOnChanges(): void {
    this.applyShell();
  }

  get shell(): WrapperCheckoutShellBinding | null {
    return this.shellBinding;
  }

  private applyShell(): void {
    this.shellBinding = this.buildShell();
    this.rootBindings = { attributes: this.shellBinding.rootAttributes };
  }

  private buildShell(): WrapperCheckoutShellBinding {
    validateCheckoutProps({
      framework: "@openreceive/angular",
      checkout: this.checkout,
      reference: this.reference,
      metadata: this.metadata,
      syncUrl: this.syncUrl,
      resumePathPrefix: this.resumePathPrefix,
      routeReference: this.routeReference,
    });
    const options: WrapperCheckoutShellOptions = {
      ...this.options,
      themeToggle: this.themeToggle ?? this.options.themeToggle ?? true,
      // Storage and matchMedia only exist in the browser: resolving the theme before
      // the elements mount would make a server-rendered shell disagree with hydration.
      deferThemeResolution: !this.elementsReady,
      ...(this.reference === undefined ? {} : { reference: this.reference }),
      ...(this.prefix === undefined ? {} : { prefix: this.prefix }),
      ...(this.paymentWizard === undefined ? {} : { paymentWizard: this.paymentWizard }),
      ...(this.decodeLinkUrl === undefined ? {} : { decodeLinkUrl: this.decodeLinkUrl }),
      ...(this.assetBaseUrl === undefined ? {} : { assetBaseUrl: this.assetBaseUrl }),
      ...(this.defaultTheme === undefined ? {} : { defaultTheme: this.defaultTheme }),
      ...(this.storageKey === undefined ? {} : { storageKey: this.storageKey }),
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      ...(this.syncUrl === undefined ? {} : { syncUrl: this.syncUrl }),
      ...(this.resumePathPrefix === undefined ? {} : { resumePathPrefix: this.resumePathPrefix }),
      ...(this.routeReference === undefined ? {} : { routeReference: this.routeReference }),
      ...(this.onCopy === undefined ? {} : { onCopy: this.onCopy }),
      ...(this.onOpenWallet === undefined ? {} : { onOpenWallet: this.onOpenWallet }),
      ...(this.onState === undefined ? {} : { onState: this.onState }),
      ...(this.onSettled === undefined ? {} : { onSettled: this.onSettled }),
      ...(this.onProviderCopy === undefined ? {} : { onProviderCopy: this.onProviderCopy }),
      ...(this.onStartOver === undefined ? {} : { onStartOver: this.onStartOver }),
      ...(this.onError === undefined ? {} : { onError: this.onError }),
    };
    return createWrapperCheckoutShellBinding(this.checkout ?? null, options);
  }
}
