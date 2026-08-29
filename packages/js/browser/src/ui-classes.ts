/**
 * Shared daisyUI / Tailwind class strings for OpenReceive checkout UI.
 * Kept as string constants so Tailwind can scan them for the prebuilt stylesheet.
 */

export const orClasses = {
  root: "grid gap-3 min-w-0",
  /**
   * What the payer is buying, above the amount. Present only when the host
   * returned a `description` from its amount hook — the checkout renders the
   * total and never the order, so this is the one line of order context the
   * default path has.
   */
  orderDescription: "text-base font-semibold leading-snug m-0 min-w-0",
  paymentLayout: "grid gap-3 grid-cols-[auto_minmax(0,1fr)] gap-x-3 md:gap-x-5 items-start min-w-0",
  paymentLayoutExpired: "grid gap-3 grid-cols-1 items-start min-w-0",
  lightningPane: "grid gap-2 items-start justify-items-start min-w-0",
  qr: "justify-self-start w-[min(148px,38vw)] md:w-[min(200px,36vw)] [&_svg]:block [&_svg]:w-full [&_svg]:h-auto",
  satsDetail:
    "text-base-content/60 text-sm leading-snug justify-self-start max-w-[min(148px,38vw)] md:max-w-[min(200px,36vw)]",
  invoiceTitle: "m-0 text-sm font-semibold leading-tight",
  paymentInfo: "grid gap-1.5 min-w-0 content-start",
  meta: "flex flex-wrap gap-1.5 items-center",
  metaItem: "badge badge-ghost badge-sm min-h-6",
  stateSettled: "badge badge-success badge-sm",
  statePending: "badge badge-ghost badge-sm",
  actions: "flex flex-wrap gap-2 justify-start",
  btn: "btn btn-outline",
  btnGhost: "btn btn-ghost",
  copyIcon: "shrink-0 size-4",
  themeToggle: "btn btn-outline btn-sm gap-2 justify-self-end",
  paymentStatus: "flex items-center gap-2.5 min-w-0",
  paymentStatusBody: "grid gap-0.5 min-w-0 flex-1",
  paymentStatusTitle: "text-base font-semibold leading-tight min-w-0",
  paymentStatusDetail: "text-base-content/60 text-sm leading-snug",
  spinner: "loading loading-spinner loading-md text-warning",
  /** Spinner on a primary button — inherit the button foreground, not the warning color. */
  continueSpinner: "loading loading-spinner loading-md shrink-0",
  settledIcon: "size-8 shrink-0 text-success",
  countdown: "text-base-content/60 text-sm",
  countdownStrong: "text-base-content font-semibold",
  creating: "grid gap-2 place-items-center p-4",
  wizard: "overflow-hidden rounded-box border border-base-content/20 bg-base-200 grid gap-0",
  wizardHeader: "grid gap-0.5 px-4 py-4 sm:px-5",
  wizardHeaderTitle: "text-lg font-bold m-0 sm:text-xl",
  wizardHeaderSubtitle: "text-base-content/65 text-sm m-0 mt-0.5",
  wizardBody: "border-t border-base-content/15 grid gap-3 p-4 sm:p-5",
  methodGrid:
    "grid grid-cols-1 items-stretch gap-2 sm:grid-cols-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-4",
  methodCardUnavailable:
    "flex h-full min-h-28 w-full flex-col items-center justify-start gap-1.5 rounded-box border border-base-content/20 bg-base-100 px-3 py-4 text-center text-base-content opacity-50 cursor-not-allowed shadow-sm",
  methodCurrenciesLoading:
    "flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-box border border-dashed border-base-content/25 bg-base-100 px-3 py-4 text-center text-base-content/70 shadow-sm sm:col-span-2 md:col-span-3 lg:col-span-4",
  methodCardReady:
    "flex h-full min-h-28 w-full flex-col items-center justify-start gap-1.5 rounded-box border border-base-content/20 bg-base-100 px-3 py-4 text-center text-base-content shadow-sm transition-colors hover:border-base-content/45 hover:bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary cursor-pointer",
  methodCardActiveBitcoin: "border-warning bg-warning/10 ring-1 ring-warning/50",
  methodCardActiveUsdt: "border-success bg-success/10 ring-1 ring-success/50",
  methodCardActiveUsdc: "border-info bg-info/10 ring-1 ring-info/50",
  methodCardActiveSol: "border-primary bg-primary/10 ring-1 ring-primary/50",
  methodCardActiveEth: "border-secondary bg-secondary/10 ring-1 ring-secondary/50",
  methodCardActiveDefault: "border-primary bg-primary/10 ring-1 ring-primary/50",
  methodIconWrap: "grid size-9 shrink-0 place-items-center overflow-hidden rounded-full sm:size-10",
  methodIcon: "size-9 aspect-square sm:size-10",
  methodTitle: "block truncate font-bold text-sm sm:text-base",
  methodTitleWrap: "min-w-0 w-full text-center",
  methodDetail: "text-base-content/60 text-xs leading-snug",
  /**
   * The line under a tile's name: what the Bitcoin tile is, or the networks a
   * coin can arrive on. Visible at EVERY width — a grid of five bare coin names
   * is a grid of five questions, and the answer is one short line long.
   */
  methodTileDetail: "block text-xs leading-snug text-base-content/60",
  /** Limit / unavailable hint under a payment tile — visible at all breakpoints. */
  methodLimitHint: "block px-1 text-center text-xs leading-snug text-base-content/55",
  methodNetworkReveal: "rounded-box border border-base-content/20 bg-base-100 p-3",
  methodNetworkRevealDesktop: "mt-3 hidden sm:block",
  methodNetworkRevealMobile: "ml-4 border-l border-base-content/30 pl-3 sm:hidden",
  methodNetworkRevealMobileUsdt: "ml-4 border-l border-success/40 pl-3 sm:hidden",
  methodNetworkRevealMobileUsdc: "ml-4 border-l border-info/40 pl-3 sm:hidden",
  methodNetworkRevealAnim:
    "grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none sm:hidden",
  methodNetworkRevealAnimOpen: "mt-2 grid-rows-[1fr] opacity-100",
  methodNetworkRevealAnimClosed: "grid-rows-[0fr] opacity-0",
  methodNetworkRevealInner: "min-h-0 overflow-hidden",
  methodNetworkLayout:
    "grid gap-3 lg:grid-cols-[9rem_minmax(0,1fr)_minmax(8rem,auto)] lg:items-start",
  methodNetworkHeading: "text-sm font-semibold text-base-content m-0",
  methodNetworkHint: "mt-0.5 text-xs text-base-content/55 m-0",
  methodNetworkGrid: "grid grid-cols-1 gap-2 min-[390px]:grid-cols-3 items-start",
  methodNetworkButton:
    "btn h-11 min-h-11 w-full justify-start gap-2 rounded-field border border-base-content/25 bg-base-100 px-3 text-sm text-base-content shadow-sm hover:border-base-content/45 hover:bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
  methodNetworkButtonUnavailable:
    "btn h-11 min-h-11 w-full justify-start gap-2 rounded-field border border-base-content/20 bg-base-100 px-3 text-sm text-base-content opacity-50 cursor-not-allowed shadow-sm pointer-events-none",
  methodNetworkButtonActiveUsdt: "border-success bg-success/10 ring-1 ring-success/50",
  methodNetworkButtonActiveUsdc: "border-info bg-info/10 ring-1 ring-info/50",
  methodNetworkButtonActiveDefault: "border-primary bg-primary/10 ring-1 ring-primary/50",
  methodNetworkIcon: "size-6 shrink-0 aspect-square",
  methodNetworkCheck:
    "ml-auto grid size-5 place-items-center rounded-full bg-success text-[0.65rem] text-success-content",
  methodNetworkCheckUsdc:
    "ml-auto grid size-5 place-items-center rounded-full bg-info text-[0.65rem] text-info-content",
  methodNetworkSummary: "mt-2 flex items-center gap-1.5 text-xs text-base-content/65 m-0",
  methodNetworkSummaryIcon:
    "grid size-4 place-items-center rounded-full bg-success text-[0.65rem] text-success-content",
  methodNetworkSummaryIconUsdc:
    "grid size-4 place-items-center rounded-full bg-info text-[0.65rem] text-info-content",
  methodConfirmDesktop: "btn btn-primary w-full gap-2",
  methodTile: "grid h-full min-w-0 content-start gap-0.5",
  breadcrumbs: "breadcrumbs text-sm",
  breadcrumbCurrent: "font-bold",
  routePicker: "grid grid-cols-2 md:grid-cols-4 gap-2",
  routeButton:
    "card card-border bg-base-100 grid gap-1.5 content-start min-h-[120px] p-2.5 text-left cursor-pointer hover:border-primary",
  routeButtonSelected:
    "card card-border bg-base-100 grid gap-1.5 content-start min-h-[120px] p-2.5 text-left border-primary ring-2 ring-primary/30",
  wizardResults: "grid gap-2.5",
  wizardEmpty: "alert",
  wizardRoute: "grid gap-3",
  wizardRouteHeading: "flex flex-wrap items-center gap-2",
  providerGrid: "grid grid-cols-1 md:grid-cols-2 gap-2",
  providerCard:
    "card card-border bg-base-100 p-3 grid gap-2 items-center grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-2 md:gap-y-1",
  providerHeading: "flex gap-2 items-center min-w-0",
  providerIcon: "rounded size-7 shrink-0",
  providerName: "font-semibold truncate m-0 min-w-0",
  providerKind: "text-base-content/60 text-sm m-0 justify-self-end text-right",
  providerActions: "col-span-2 flex w-full md:col-span-1 md:w-auto md:justify-self-end",
  providerOpen: "btn btn-outline btn-sm w-full md:w-auto",
  swapActions: "grid gap-2.5 grid-cols-1 md:grid-cols-3",
  swapAction: "grid gap-2",
  swapEstimate: "text-base-content/60 m-0 text-sm",
  swapWarning: "alert alert-warning text-sm",
  swapNetworkWarning: "alert alert-error alert-soft text-sm items-start gap-3",
  /**
   * Same deposit heading on a rail whose address format pins both the chain and
   * the asset (`SwapDepositRisk` "pinned"): identical layout, no alarm colour
   * and no warning triangle. A red banner on every rail is read on none.
   */
  swapNetworkNotice: "alert alert-soft text-sm items-start gap-3",
  swapNetworkWarningIcon: "size-6 shrink-0 stroke-current",
  swapNetworkWarningContent: "grid gap-1 min-w-0 w-full",
  swapNetworkWarningTitle: "font-bold m-0",
  swapNetworkWarningBody: "m-0",
  swapNetworkWarningEmphasis: "font-bold underline",
  swapProgress: "text-base-content/60 m-0",
  swapInstruction: "m-0 text-base-content text-base font-bold text-center md:text-left",
  swapStart: "btn btn-outline",
  swapPanel: "grid gap-3",
  swapDepositLayout:
    "grid gap-3 md:grid-cols-[auto_minmax(0,1fr)] md:gap-x-5 md:items-start min-w-0",
  swapDepositSide: "grid gap-3 min-w-0 content-start",
  swapHeading: "flex flex-wrap gap-2 items-center justify-between",
  /**
   * The heading on the three refund states. Same content as `swapHeading`, in
   * an alert: "Refund needed" is not a section title, it is the payer being
   * told their money did not go where they sent it for.
   */
  swapRefundHeading: "alert alert-error alert-soft items-start gap-3 text-left",
  /**
   * The return callout, which sits ABOVE the refund form rather than under the
   * support details. It is the sentence that decides whether the payer can come
   * back at all, and a payer who has to leave for an address in another wallet
   * reads it before they go, not after they scroll past the form.
   */
  swapRefundReturn: "alert alert-warning alert-soft items-start gap-3 text-left",
  swapRefundReturnTitle: "font-bold m-0",
  swapRefundReturnBody: "m-0 font-semibold",
  swapHeadingTitle: "text-lg font-semibold",
  swapHeadingDetail: "text-base-content/60",
  swapQr: "block h-auto w-[min(208px,100%)]",
  /**
   * The white card the code sits on. A QR is only scannable against white, and a
   * bare code floating on the panel background reads as an artifact of the page
   * rather than the thing to point a phone at.
   */
  swapQrFrame:
    "grid place-items-center justify-self-center rounded-box border border-base-content/15 bg-white p-3 md:justify-self-start [&_svg]:block [&_svg]:h-auto [&_svg]:w-[min(208px,100%)]",
  swapDetails: "grid gap-2 m-0",
  swapDetailsDt: "text-base-content/60 text-xs font-bold uppercase",
  swapDetailsDd: "grid gap-2 grid-cols-[minmax(0,1fr)_auto] items-center m-0",
  swapDetailsCode: "min-w-0 break-all font-mono text-sm",
  // Readonly select-all fields: keep the quiet resting border, suppress daisyUI's
  // focus outline+offset which otherwise reads as a double ring around selected text.
  swapDetailsInput:
    "input input-sm w-full min-w-0 font-mono text-sm outline-none! focus:outline-none! focus:outline-offset-0!",
  swapDetailsActions: "flex flex-wrap gap-2 justify-end",
  detailCopy: "btn btn-sm btn-square btn-ghost",
  swapDetailsLink: "btn btn-sm btn-outline",
  swapBreakdown: "grid gap-2 rounded-box border border-base-content/15 bg-base-100 px-3 py-2.5",
  swapBreakdownTitle: "m-0 text-base-content/60 text-xs font-bold uppercase",
  swapBreakdownRows: "grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 items-baseline m-0",
  swapWaitingTitle: "flex items-baseline justify-between gap-3 min-w-0",
  swapCountdown: "shrink-0 text-base-content font-semibold tabular-nums",
  swapBack: "btn btn-sm btn-outline justify-self-start",
  swapSupport: "collapse collapse-arrow bg-base-200",
  swapSupportTitle: "collapse-title font-bold min-h-0 py-2",
  swapSupportContent: "collapse-content",
  transactionDetails: "collapse collapse-arrow bg-base-200",
  transactionDetailsTitle: "collapse-title font-bold min-h-0 py-2",
  transactionDetailsContent: "collapse-content",
  swapRefund: "grid gap-2 rounded-box border border-base-content/15 bg-base-100 px-3 py-2.5",
  /** Section titles inside a card: the breakdown, the refund form, the keep-this note. */
  swapSectionTitle: "m-0 text-base-content/60 text-xs font-bold uppercase tracking-wide",
  swapRefundReason: "m-0 text-base-content/60 text-sm",
  swapRefundInstruction: "m-0 text-sm",
  /**
   * What the provider says about the money — sent, expected, coming back — as a
   * quiet fact table. Not copy rows: nobody pastes "0.04 SOL" anywhere, and a
   * column of copy buttons on the worst screen in the flow reads as four more
   * things to do.
   */
  swapFacts: "grid gap-1.5 rounded-box border border-base-content/15 bg-base-100 px-3 py-2.5 m-0",
  swapFactsRow: "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3",
  swapFactsLabel: "text-base-content/60 text-sm m-0",
  swapFactsValue: "text-sm m-0 tabular-nums",
  /**
   * The way back into this payment, on every screen and not only the refund
   * one. A payer with no account has nothing else that reaches this page again,
   * and the moment to copy it is BEFORE the deposit goes wrong.
   */
  keepOrder: "grid gap-1.5 rounded-box border border-base-content/15 bg-base-100 px-3 py-2.5",
  keepOrderBody: "m-0 text-base-content/60 text-sm",
  swapRefundInput: "input input-bordered w-full",
  swapRefundInputInvalid: "input input-bordered input-error w-full",
  swapRefundError: "m-0 text-error text-sm",
  swapRefundHint: "m-0 text-warning text-sm",
  tutorialModal: "modal modal-open",
  tutorialBox: "modal-box grid gap-3 max-w-[min(440px,100%)]",
  tutorialHeader: "flex gap-2 items-center justify-between",
  tutorialTitle: "flex items-center gap-2.5 min-w-0",
  tutorialHeaderLogo: "size-9 rounded shrink-0",
  tutorialClose: "btn btn-sm btn-square btn-ghost",
  tutorialFrame:
    "flex items-center justify-center min-h-0 overflow-hidden rounded-box border border-base-content/20 bg-base-200",
  tutorialImage: "block w-auto max-w-full h-auto max-h-[min(66vh,720px)] object-contain",
  tutorialCaption: "m-0 text-base font-bold text-center",
  tutorialIntro: "grid gap-3 p-4 text-center",
  tutorialProviderLogo: "justify-self-center size-[52px] rounded",
  tutorialCopy: "btn btn-outline justify-self-center min-w-[min(240px,100%)]",
  tutorialCopyMessage: "text-success font-bold",
  tutorialProgress: "m-0 text-base-content/60 text-xs text-center",
  tutorialSteps: "flex gap-1.5 justify-center",
  tutorialStep: "badge badge-xs badge-ghost size-2 p-0",
  tutorialStepActive: "badge badge-xs badge-neutral size-2 p-0",
  tutorialControls: "grid grid-cols-2 gap-2",
} as const;
