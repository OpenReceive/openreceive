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
  type OpenReceiveAngularCheckoutShellBinding,
  type OpenReceiveAngularCheckoutShellOptions,
  type OpenReceiveThemePreference,
  createOpenReceiveAngularCheckoutShellBinding,
  defineOpenReceiveElements,
  validateOpenReceiveWrapperCheckoutProps,
} from "@openreceive/angular";
import { OpenReceiveElementBindingsDirective } from "./openreceive-element-bindings.directive";

@Component({
  selector: "openreceive-angular-checkout",
  standalone: true,
  imports: [OpenReceiveElementBindingsDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <section
      [attr.data-theme]="shell.rootAttributes['data-theme']"
      [attr.data-openreceive-theme]="shell.rootAttributes['data-openreceive-theme']"
    >
      @if (elementsReady) {
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
  // docs/internal/wrapper-parity.md. Keep these inputs in step with it.
  // Snapshot mode: bind a `checkout` to render it directly.
  // Create mode: omit `checkout` and bind `orderId` (+ optional `prefix`); the underlying
  // <openreceive-checkout> element creates the checkout, then renders and polls itself.
  @Input() checkout?: CheckoutSnapshot | null;
  @Input() orderId?: string;
  @Input() prefix?: string;
  @Input() orderUrl?: string;
  @Input() paymentWizard?: boolean;
  @Input() decodeLinkUrl?: string;
  @Input() themeToggle = true;
  @Input() defaultTheme?: OpenReceiveThemePreference;
  @Input() storageKey?: string;
  // Create mode only.
  @Input() metadata?: Record<string, unknown>;
  @Input() syncUrl?: boolean;
  @Input() resumePathPrefix?: string;
  @Input() routeOrderId?: string;
  @Input() onCopy?: (event: Event) => void;
  @Input() onOpenWallet?: (event: Event) => void;
  @Input() onState?: (event: Event) => void;
  @Input() onSettled?: (event: Event) => void;
  @Input() onProviderCopy?: (event: Event) => void;
  @Input() onStartOver?: (event: Event) => void;
  @Input() onError?: (event: Event) => void;
  @Input() options: OpenReceiveAngularCheckoutShellOptions = {};

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
  protected shellBinding: OpenReceiveAngularCheckoutShellBinding = this.buildShell();

  ngAfterViewInit(): void {
    // No-op during Angular Universal SSR: custom elements only exist in the
    // browser, and the element renders itself after hydration.
    if (globalThis.customElements === undefined || globalThis.HTMLElement === undefined) return;
    this.zone.runOutsideAngular(() => {
      defineOpenReceiveElements();
      this.elementsReady = true;
      // Rebuild so the mounted shell carries the stored theme, not the deferred default.
      this.shellBinding = this.buildShell();
      this.changeDetector.detectChanges();
    });
  }

  ngOnChanges(): void {
    this.shellBinding = this.buildShell();
  }

  get shell(): OpenReceiveAngularCheckoutShellBinding {
    return this.shellBinding;
  }

  private buildShell(): OpenReceiveAngularCheckoutShellBinding {
    validateOpenReceiveWrapperCheckoutProps({
      framework: "@openreceive/angular",
      checkout: this.checkout,
      orderId: this.orderId,
      metadata: this.metadata,
      syncUrl: this.syncUrl,
      resumePathPrefix: this.resumePathPrefix,
      routeOrderId: this.routeOrderId,
    });
    const options: OpenReceiveAngularCheckoutShellOptions = {
      ...this.options,
      themeToggle: this.themeToggle,
      // Storage and matchMedia only exist in the browser: resolving the theme before
      // the elements mount would make a server-rendered shell disagree with hydration.
      deferThemeResolution: !this.elementsReady,
      ...(this.orderId === undefined ? {} : { orderId: this.orderId }),
      ...(this.prefix === undefined ? {} : { prefix: this.prefix }),
      ...(this.orderUrl === undefined ? {} : { orderUrl: this.orderUrl }),
      ...(this.paymentWizard === undefined ? {} : { paymentWizard: this.paymentWizard }),
      ...(this.decodeLinkUrl === undefined ? {} : { decodeLinkUrl: this.decodeLinkUrl }),
      ...(this.defaultTheme === undefined ? {} : { defaultTheme: this.defaultTheme }),
      ...(this.storageKey === undefined ? {} : { storageKey: this.storageKey }),
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      ...(this.syncUrl === undefined ? {} : { syncUrl: this.syncUrl }),
      ...(this.resumePathPrefix === undefined ? {} : { resumePathPrefix: this.resumePathPrefix }),
      ...(this.routeOrderId === undefined ? {} : { routeOrderId: this.routeOrderId }),
      ...(this.onCopy === undefined ? {} : { onCopy: this.onCopy }),
      ...(this.onOpenWallet === undefined ? {} : { onOpenWallet: this.onOpenWallet }),
      ...(this.onState === undefined ? {} : { onState: this.onState }),
      ...(this.onSettled === undefined ? {} : { onSettled: this.onSettled }),
      ...(this.onProviderCopy === undefined ? {} : { onProviderCopy: this.onProviderCopy }),
      ...(this.onStartOver === undefined ? {} : { onStartOver: this.onStartOver }),
      ...(this.onError === undefined ? {} : { onError: this.onError }),
    };
    return createOpenReceiveAngularCheckoutShellBinding(this.checkout ?? null, options);
  }
}
