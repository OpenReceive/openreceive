import {
  buildMethodGridEntries,
  type CheckoutController,
  type CheckoutInvoiceSnapshot,
  type CheckoutPaymentMethod,
  type CheckoutSession,
  type CheckoutSnapshot,
  type CheckoutState,
  createCheckoutController,
  createCheckoutSession,
  createCheckoutStatusModel,
  createMethodGridDisplay,
  createSwapDisplayModel,
  createSwapUnavailableModel,
  createTransactionDetailsFromState,
  getSwapRefundFormError,
  mergeAttemptIntoSnapshot,
  normalizeSwapStartInvoice,
  paymentMethods,
  prepareCheckout,
  requestCheckout,
  resolveWizardSelection,
  selectCheckoutDisplayInvoice,
  selectCurrentSwapInvoice,
} from "@openreceive/browser/headless";
import { computed } from "mobx";
import { type Frozen, frozen, Model, model, modelAction, prop } from "mobx-keystone";
import {
  checkoutUrlFor,
  forgetSwapAttempt,
  readSwapAttempt,
  rememberSwapAttempt,
} from "../../checkout-resume.ts";
import { csrfFetch } from "../../http.ts";

const invoiceKey = (snapshot: CheckoutSnapshot | null): string =>
  snapshot ? snapshot.invoices.map((invoice) => invoice.invoice_id).join("|") : "";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? "Something went wrong.");

/**
 * One order's payment, as a store.
 *
 * Everything here that could have been hand-rolled is not:
 * `createCheckoutController` owns the poll loop, the backoff and the countdown;
 * `createCheckoutSession` owns the deferred Lightning mint, the swap
 * quote-then-start and the double-click guards; `resolveWizardSelection`
 * decides whether a tile even has a network question to ask; the display models
 * turn wire state into finished copy. The store's job is to hold what they
 * publish and let mobx redraw.
 *
 * The controller and the session are PLAIN INSTANCE FIELDS, not props: they own
 * timers and callbacks, which are not snapshot data, and mobx-keystone would
 * try to deep-convert them — breaking the poll loop in ways that do not look
 * like a state bug. Everything the components read goes through a prop, so
 * mobx-react sees every change.
 */
@model("or/ShopCheckout")
export class ShopCheckout extends Model({
  reference: prop<string>(""),
  prefix: prop<string>("/openreceive"),
  snapshot: prop<Frozen<CheckoutSnapshot> | null>(null),
  state: prop<Frozen<CheckoutState> | null>(null),

  // Which method tile is open, and the network chosen inside each multi-network
  // coin. The engine decides what a click MEANS; this is only what was clicked.
  //
  // The map is keyed by the group's own normalized key ("USDT") and VALUED by
  // the chosen option's `pay_in_asset` ("USDT_TRON") — not by the network label
  // it is named after. Both sides are plain strings, so nothing catches storing
  // the label here; the tile simply never looks selected and `continueTarget`
  // never appears.
  pickerKey: prop<string | null>(null),
  selectedAssetByGroup: prop<Record<string, string>>(() => ({})),

  // The swap attempt the wizard is showing. This stays HOST state: the
  // breadcrumb, the deposit panel and the refund draft all read it, and
  // CheckoutSession reaches it through accessors rather than keeping a second
  // copy that could disagree. Without it `session.startSwap` is a silent no-op.
  startedSwap: prop<Frozen<CheckoutInvoiceSnapshot> | null>(null),
  dismissedInvoiceId: prop<string | null>(null),
  selectedSwapAsset: prop<string | null>(null),

  // Mirrors of CheckoutSession state, bumped from its onChange. See the
  // `void this.sessionTick` lines below.
  sessionTick: prop<number>(0),

  preparing: prop<boolean>(false),
  errorMessage: prop<string>(""),

  // The swap refund form: two steps, and only the second submits.
  refundAddress: prop<string>(""),
  refundStagedAddress: prop<string>(""),
  refundSubmitting: prop<boolean>(false),
  refundNotice: prop<string>(""),
}) {
  private controller?: CheckoutController;
  private controllerKey = "";
  private session?: CheckoutSession;

  // --------------------------------------------------------------- lifecycle

  // A plain async arrow, never @modelAction: an `await` ENDS an action, so
  // every mutation here is a call to a small named action.
  begin = async (reference: string): Promise<void> => {
    this.reset(reference);
    this.setPreparing(true);
    try {
      // Prepare locks the amount and returns the pay-in catalog without minting
      // anything: the payer sees what they are buying and every way to pay it
      // before a single invoice exists.
      const prepared = await prepareCheckout({
        reference,
        prefix: this.prefix,
        fetch: csrfFetch,
      });
      this.applySnapshot(prepared);
      // THE OTHER HALF OF THE URL. See resumeSwapAttempt.
      await this.resumeSwapAttempt(reference);
    } catch (error) {
      this.setError(errorText(error));
    } finally {
      this.setPreparing(false);
    }
  };

  /**
   * The deposit this order already has, put back on screen.
   *
   * Prepare answers with the amount and the pay-in catalog and NO attempts, so
   * without this a bookmarked checkout opens on the method grid and a payer who
   * was told to come back and claim a refund finds a shop.
   *
   * `POST /swaps/status` addresses ONE attempt by payment hash, with no reuse
   * test — see ../../checkout-resume.ts for why the hash is the durable handle
   * and re-picking the coin is not. The route is built by hand because the
   * packages export no route builder; `normalizeSwapStartInvoice` and
   * `mergeAttemptIntoSnapshot` are the two halves that turn its answer into the
   * snapshot the poll controller and every display model already read.
   *
   * A miss is silence, not an error: an attempt the server will not serve is a
   * stale note in this browser, and the payer belongs on the method grid.
   */
  private resumeSwapAttempt = async (reference: string): Promise<void> => {
    const paymentHash = readSwapAttempt(reference);
    if (!paymentHash) return;
    const response = await csrfFetch(`${this.prefix}/swaps/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ reference, payment_hash: paymentHash }),
    });
    if (!response.ok) {
      forgetSwapAttempt(reference);
      return;
    }
    const invoice = normalizeSwapStartInvoice(await response.json());
    this.setStartedSwap(invoice);
    const current = this.snapshotValue;
    if (current) this.applySnapshot(mergeAttemptIntoSnapshot(invoice, current));
  };

  // Anything that starts something must be able to stop it. Called from
  // `reset`, from ShopStore.startOver, and from the panel's unmount effect.
  dispose = (): void => {
    this.controller?.stop();
    this.controller = undefined;
    this.controllerKey = "";
    this.session = undefined;
  };

  // dispose() FIRST, then clear props — the other order lets a live poll write
  // into freshly-cleared state.
  @modelAction
  private reset(reference: string) {
    this.dispose();
    this.reference = reference;
    this.snapshot = null;
    this.state = null;
    this.pickerKey = null;
    this.selectedAssetByGroup = {};
    this.startedSwap = null;
    this.dismissedInvoiceId = null;
    this.selectedSwapAsset = null;
    this.errorMessage = "";
    this.refundAddress = "";
    this.refundStagedAddress = "";
    this.refundNotice = "";
  }

  @modelAction
  private setPreparing(value: boolean) {
    this.preparing = value;
  }

  @modelAction
  setError(message: string) {
    this.errorMessage = message;
  }

  // frozen(), because these are foreign wire objects: replaced wholesale on
  // every poll, never edited in place, and not ours to model.
  @modelAction
  private setSnapshot(snapshot: CheckoutSnapshot) {
    this.snapshot = frozen(snapshot);
  }

  @modelAction
  private setState(state: CheckoutState) {
    this.state = frozen(state);
  }

  @modelAction
  private bumpSession() {
    this.sessionTick += 1;
  }

  @modelAction
  private setStartedSwap(invoice: CheckoutInvoiceSnapshot) {
    this.startedSwap = frozen(invoice);
  }

  @modelAction
  private setDismissedInvoiceId(invoiceId: string | null) {
    this.dismissedInvoiceId = invoiceId;
  }

  @modelAction
  private setSelectedSwapAsset(payInAsset: string | null) {
    this.selectedSwapAsset = payInAsset;
  }

  // Every new snapshot lands here: from prepare, from the controller's polling,
  // from a Lightning mint, from a started swap. When the set of attempts
  // changes, the poll controller is re-keyed onto the new snapshot — that is
  // what makes a fresh bolt11 or a fresh deposit the thing being watched.
  private applySnapshot = (snapshot: CheckoutSnapshot) => {
    this.setSnapshot(snapshot);

    const key = invoiceKey(snapshot);
    if (this.controller && key === this.controllerKey) return;

    this.controllerKey = key;
    this.controller?.stop();
    this.controller = createCheckoutController({
      snapshot,
      prefix: this.prefix,
      fetch: csrfFetch,
      onState: (state) => this.setState(state),
      onSnapshot: (next) => this.applySnapshot(next),
      onError: (error) => this.setError(errorText(error)),
    });
    this.controller.start();

    if (!this.session) this.session = this.buildSession();
  };

  private buildSession(): CheckoutSession {
    return createCheckoutSession({
      snapshot: () => this.snapshotValue ?? undefined,
      reference: () => this.reference || undefined,
      // Passing `previous` keeps the pay-in catalog and any sibling attempt: the
      // mint response carries the bolt11 alone, so without it a payer who picks
      // Bitcoin and changes their mind finds the swap options gone.
      requestCheckout: (reference) =>
        requestCheckout({
          reference,
          prefix: this.prefix,
          fetch: csrfFetch,
          previous: this.snapshotValue ?? undefined,
        }),
      onSnapshot: this.applySnapshot,
      // Swap support is all of it or none of it: one option rather than three
      // optional fields, so a host that wires two of the three can no longer
      // get silence out of `startSwap`.
      swap: {
        // Host state the session reads and writes through accessors, rather
        // than keeping a second copy that could disagree with ours.
        selection: {
          started: () => this.startedSwap?.data,
          setStarted: (invoice: CheckoutInvoiceSnapshot) => this.setStartedSwap(invoice),
          dismissedInvoiceId: () => this.dismissedInvoiceId,
          setDismissedInvoiceId: (invoiceId: string | null) =>
            this.setDismissedInvoiceId(invoiceId),
          setSelectedAsset: (payInAsset: string | null) => this.setSelectedSwapAsset(payInAsset),
        },
        prefix: () => this.prefix,
        fetch: () => csrfFetch,
        // The merge stays on the host side of this callback: re-keying the poll
        // controller onto the merged snapshot is what makes the fresh deposit
        // the thing being watched.
        onStarted: (invoice: CheckoutInvoiceSnapshot) => {
          const current = this.snapshotValue;
          if (!current) return;
          this.applySnapshot(mergeAttemptIntoSnapshot(invoice, current));
        },
      },
      onError: (error) => this.setError(errorText(error)),
      onChange: () => this.bumpSession(),
    });
  }

  // ----------------------------------------------------------------- reading

  // Read a frozen value through `.data`, always. Components read
  // `snapshotValue`, never `snapshot`.
  @computed
  get snapshotValue(): CheckoutSnapshot | null {
    return this.snapshot?.data ?? null;
  }

  @computed
  get stateValue(): CheckoutState | null {
    return this.state?.data ?? null;
  }

  // Render the MODEL's phase, never the snapshot's: a live-looking checkout
  // whose countdown has run out is reported as expired here, so the screen turns
  // over the moment the clock does rather than when the next poll disagrees.
  @computed
  get status() {
    return createCheckoutStatusModel(this.stateValue ?? undefined);
  }

  @computed
  get settled(): boolean {
    return this.status.phase === "settled";
  }

  @computed
  get description(): string {
    return this.snapshotValue?.description ?? "";
  }

  @computed
  get displayInvoice() {
    const snapshot = this.snapshotValue;
    return snapshot ? selectCheckoutDisplayInvoice(snapshot) : undefined;
  }

  // The bolt11 the QR and the copy button render. The live state wins; the
  // snapshot's display invoice is the fallback for the moment between a mint
  // landing and the controller re-keying onto it.
  @computed
  get lightningInvoice(): string {
    const state = this.stateValue;
    if (state && state.rail === "lightning" && state.invoice) return state.invoice;
    const invoice = this.displayInvoice;
    return invoice && invoice.rail === "lightning" ? (invoice.invoice ?? "") : "";
  }

  @computed
  get swapMethods(): readonly CheckoutPaymentMethod[] {
    return this.snapshotValue?.payment_methods ?? [];
  }

  @computed
  get gridEntries() {
    return buildMethodGridEntries(paymentMethods, this.swapMethods);
  }

  // The tiles, with the rule about limits already applied: a disabled tile
  // carries `limitMessage` ("Minimum amount $2.71") quoted from its group's
  // cheapest entry point, so an unavailable method says why in dollars.
  @computed
  get methodGrid() {
    const snapshot = this.snapshotValue;
    return createMethodGridDisplay({
      entries: this.gridEntries,
      selectedPickerKey: this.pickerKey,
      selectedAssetByGroup: this.selectedAssetByGroup,
      startingAsset: this.startingSwapAsset,
      checkout: snapshot ? { amount_msats: snapshot.amount_msats, fiat: snapshot.fiat } : undefined,
    });
  }

  // THE sessionTick ESCAPE HATCH.
  //
  // `CheckoutSession` is an external object holding its own non-observable
  // state; mobx cannot see into it. The bare `void this.sessionTick` below IS
  // the subscription — without it the getter reads a plain field and NEVER
  // recomputes, so the spinner never stops and there is no error anywhere.
  // Do not delete those lines.
  //
  // This is an escape hatch for foreign state, not a pattern to reach for.
  // RecentOrders owns all its own state and needs none of it.
  @computed
  get startingSwapAsset(): string | null {
    void this.sessionTick;
    return this.session?.startingSwapAsset ?? null;
  }

  @computed
  get mintingLightning(): boolean {
    void this.sessionTick;
    return this.session?.mintingLightning ?? false;
  }

  @computed
  get lightningRequested(): boolean {
    void this.sessionTick;
    return this.session?.lightningRequested ?? false;
  }

  @computed
  get swapStartError(): string {
    void this.sessionTick;
    return this.session?.swapStartError ?? "";
  }

  // The four-part pane for a method the payer navigated to and cannot use.
  @computed
  get swapUnavailable() {
    void this.sessionTick;
    const asset = this.selectedSwapAsset;
    if (!asset) return undefined;
    const quote = this.session?.swapQuotes?.[asset];
    if (!quote || quote.available) return undefined;
    const snapshot = this.snapshotValue;
    return createSwapUnavailableModel(
      quote,
      snapshot ? { amount_msats: snapshot.amount_msats, fiat: snapshot.fiat } : undefined,
    );
  }

  // The live deposit panel, when there is a swap attempt to show.
  //
  // `selectCurrentSwapInvoice` is the three rules a renderer needs and would
  // otherwise re-derive: the polled snapshot's copy of the attempt, the locally
  // started one while polling catches up, and the staged refund address folded
  // over either — so a review in progress survives a status tick.
  @computed
  get swapDisplay() {
    const invoice = selectCurrentSwapInvoice(this.snapshotValue ?? undefined, {
      started: this.startedSwap?.data ?? null,
      dismissedInvoiceId: this.dismissedInvoiceId,
    });
    if (!invoice) return undefined;
    // `resumable` decides ONE string — `refundReturnLabel`, the sentence the
    // refund screen shows about getting back here — and the safe default is the
    // one that says "do not close this tab". This shop earns the other one: the
    // order lives at `/checkout/:reference` on every stack, and every server
    // serves the SPA there. See ../../checkout-resume.ts.
    return createSwapDisplayModel(invoice, { resumable: true });
  }

  /** The URL of this checkout — what the refund screen tells the payer to keep. */
  @computed
  get checkoutUrl(): string {
    return this.reference ? checkoutUrlFor(this.reference) : "";
  }

  // The payer's evidence that they paid: order and checkout ids, the rail, the
  // amount in sats and fiat, the bolt11, the payment hash, and every swap field
  // the provider reported.
  @computed
  get transactionRows() {
    const state = this.stateValue;
    // `checkout_lock` is the deferred placeholder that exists between prepare
    // and the payer choosing a method. There is no transaction to show yet, so
    // the panel stays away rather than offering a caret over an empty record.
    if (!state || state.rail === "checkout_lock") return [];
    return createTransactionDetailsFromState(state);
  }

  @computed
  get refundFormError(): string | undefined {
    const swap = this.swapDisplay;
    if (!swap) return undefined;
    return getSwapRefundFormError(swap.payInAsset, this.refundAddress, swap.networkLabel);
  }

  // ----------------------------------------------------------------- actions

  // What a tile click MEANS is the engine's answer, not ours: a one-network
  // coin comes back as `start_swap` and can never be asked which network it is
  // on, which is exactly where that question would teach a payer to click past
  // it on USDT.
  selectTile = (pickerKey: string) => {
    const selection = resolveWizardSelection({
      pickerKey,
      previousKey: this.pickerKey,
      entries: this.gridEntries,
      selectedAssetByGroup: this.selectedAssetByGroup,
    });

    switch (selection.kind) {
      case "select_method":
        this.setPickerKey(pickerKey);
        void this.ensureLightning();
        return;
      case "start_swap":
        this.setPickerKey(pickerKey);
        void this.startSwap(selection.payInAsset);
        return;
      case "choose_network":
        this.setPickerKey(pickerKey);
        this.setSelectedAssetByGroup(selection.selectedAssetByGroup);
        return;
      default:
        this.setPickerKey(null);
    }
  };

  // See the prop declaration: keyed by group key, valued by `pay_in_asset`.
  chooseNetwork = (groupKey: string, payInAsset: string) => {
    this.setSelectedAssetByGroup({ ...this.selectedAssetByGroup, [groupKey]: payInAsset });
  };

  continueWithSelection = () => {
    const target = this.methodGrid.continueTarget;
    if (!target || target.disabled) return;
    void this.startSwap(target.payInAsset);
  };

  @modelAction
  setPickerKey(pickerKey: string | null) {
    this.pickerKey = pickerKey;
    this.errorMessage = "";
  }

  @modelAction
  private setSelectedAssetByGroup(selected: Record<string, string>) {
    this.selectedAssetByGroup = selected;
  }

  // The breadcrumb back out of a chosen method. Backwards movement, not a step
  // back — and it drops a refund the payer had begun reviewing, because leaving
  // for Lightning is the one exit that is not a submitted refund.
  backToMethods = () => {
    this.controller?.clearSwapRefundStaging();
    this.session?.clearSwapStartError();
    this.clearRefundStaging();
    // A dismissed attempt is invisible until a new start or a refund clears the
    // dismissal — the deposit panel must not survive the payer walking away
    // from it.
    const invoice = this.swapDisplay ? (this.startedSwap?.data?.invoice_id ?? null) : null;
    this.setDismissedInvoiceId(invoice);
    this.setSelectedSwapAsset(null);
    this.setPickerKey(null);
  };

  ensureLightning = async () => {
    if (!this.session) return;
    await this.session.ensureLightning();
  };

  startSwap = async (payInAsset: string) => {
    if (!this.session) return;
    await this.session.startSwap(payInAsset);
    // Remembered only once a deposit exists, and never cleared by walking back
    // to the methods: the deposit is real money and the payer may need this
    // screen again long after they stopped looking at it.
    // The PAYMENT HASH, not `swapDisplay.attemptId`: the display model's
    // attempt id falls back to the hash but prefers the provider's own
    // `attempt_id`, and `/swaps/status` takes the hash.
    const paymentHash = this.startedSwap?.data?.payment_hash;
    if (paymentHash) rememberSwapAttempt(this.reference, paymentHash);
  };

  copyInvoice = async () => {
    await this.controller?.copyInvoice();
  };

  // `openWallet` navigates the CURRENT window at a `lightning:` URI, so it is
  // offered on touch devices only — see LightningPanel.
  openWallet = () => this.controller?.openWallet();

  @modelAction
  setRefundAddress(address: string) {
    this.refundAddress = address;
    this.refundNotice = "";
  }

  @modelAction
  private clearRefundStaging() {
    this.refundStagedAddress = "";
    this.refundAddress = "";
    this.refundSubmitting = false;
    this.refundNotice = "";
  }

  @modelAction
  private setRefundStaged(address: string) {
    this.refundStagedAddress = address;
  }

  @modelAction
  private setRefundSubmitting(value: boolean) {
    this.refundSubmitting = value;
  }

  @modelAction
  private setRefundNotice(message: string) {
    this.refundNotice = message;
  }

  // Step one. This posts /swaps/status and holds the address for review; it
  // touches no refund route. The controller folds the staged address back into
  // every later snapshot, so polling cannot wipe what the payer is reading.
  stageRefund = async () => {
    const swap = this.swapDisplay;
    if (!swap || !this.controller || this.refundFormError) return;
    this.setRefundSubmitting(true);
    try {
      await this.controller.stageSwapRefund({
        attemptId: swap.attemptId,
        refundAddress: this.refundAddress,
      });
      this.setRefundStaged(this.refundAddress);
    } catch (error) {
      this.setRefundNotice(errorText(error));
    } finally {
      this.setRefundSubmitting(false);
    }
  };

  // Step two, and the only call that submits. A refund is possible from exactly
  // one provider state and the server re-reads it here, so a 409 is a normal
  // outcome — the state moved under the payer — not an error screen.
  confirmRefund = async () => {
    const swap = this.swapDisplay;
    if (!swap || !this.controller || !this.refundStagedAddress) return;
    this.setRefundSubmitting(true);
    try {
      await this.controller.confirmSwapRefund({
        attemptId: swap.attemptId,
        refundAddress: this.refundStagedAddress,
      });
      this.setRefundNotice("Refund submitted.");
      this.setRefundStaged("");
    } catch (error) {
      const conflict = (error as { status?: number })?.status === 409;
      this.setRefundNotice(
        conflict
          ? "This deposit is no longer refundable — its status changed while you were confirming."
          : errorText(error),
      );
      this.setRefundStaged("");
    } finally {
      this.setRefundSubmitting(false);
    }
  };

  cancelRefundReview = () => {
    this.controller?.clearSwapRefundStaging();
    this.clearRefundStaging();
  };
}
