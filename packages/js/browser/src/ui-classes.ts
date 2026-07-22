/**
 * Shared daisyUI / Tailwind class strings for OpenReceive checkout UI.
 * Kept as string constants so Tailwind can scan them for the prebuilt stylesheet.
 */

export const orClasses = {
  root: "grid gap-3 min-w-0",
  paymentLayout:
    "grid gap-3 grid-cols-[auto_minmax(0,1fr)] gap-x-3 md:gap-x-5 items-start min-w-0",
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
  btn: "btn btn-soft",
  btnGhost: "btn btn-ghost",
  btnSoft: "btn btn-soft",
  btnBlock: "btn btn-block btn-soft",
  btnSm: "btn btn-sm btn-soft",
  btnSquare: "btn btn-square btn-sm btn-soft",
  copyIcon: "shrink-0 size-4",
  themeToggle: "btn btn-ghost btn-sm gap-2 justify-self-end",
  textarea: "textarea textarea-bordered w-full font-mono text-sm min-h-[86px]",
  paymentStatus: "flex items-center gap-2.5 min-w-0",
  paymentStatusBody: "grid gap-0.5 min-w-0 flex-1",
  paymentStatusTitle: "text-base font-semibold leading-tight min-w-0",
  paymentStatusDetail: "text-base-content/60 text-sm leading-snug",
  spinner: "loading loading-spinner loading-md text-warning",
  countdown: "text-base-content/60 text-sm",
  countdownStrong: "text-base-content font-semibold",
  creating: "grid gap-2 place-items-center p-4",
  wizard: "overflow-hidden rounded-box border border-base-300 bg-base-200 grid gap-0",
  wizardHeader: "grid gap-0.5 px-4 py-4 sm:px-5",
  wizardHeaderTitle: "text-lg font-bold m-0 sm:text-xl",
  wizardHeaderSubtitle: "text-base-content/65 text-sm m-0 mt-0.5",
  wizardBody: "border-t border-base-300 grid gap-3 p-4 sm:p-5",
  methodSelector: "grid gap-3",
  methodGrid:
    "grid grid-cols-1 items-start gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-5",
  methodCard:
    "flex min-h-14 w-full items-center justify-start gap-3 rounded-field border border-base-300 bg-base-100 px-3 py-2 text-left text-base-content shadow-none transition-colors hover:border-base-content/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-4 cursor-pointer",
  methodCardUnavailable:
    "flex min-h-14 w-full items-center justify-start gap-3 rounded-field border border-base-300 bg-base-100 px-3 py-2 text-left text-base-content opacity-50 cursor-not-allowed shadow-none sm:px-4",
  methodCardStatic:
    "flex min-h-14 w-full items-center justify-start gap-3 rounded-field border border-base-300 bg-base-100 px-3 py-2 text-left text-base-content shadow-none sm:px-4",
  methodCurrenciesLoading:
    "flex min-h-14 w-full items-center justify-start gap-3 rounded-field border border-dashed border-base-300 bg-base-100 px-3 py-2 text-left text-base-content/70 shadow-none sm:px-4 sm:col-span-2 lg:col-span-4",
  methodCardReady:
    "flex min-h-14 w-full items-center justify-start gap-3 rounded-field border border-base-300 bg-base-100 px-3 py-2 text-left text-base-content shadow-none transition-colors hover:border-base-content/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-4 cursor-pointer",
  methodCardActiveBitcoin:
    "border-warning bg-warning/10 ring-1 ring-warning/50",
  methodCardActiveUsdt:
    "border-success bg-success/10 ring-1 ring-success/50",
  methodCardActiveUsdc:
    "border-info bg-info/10 ring-1 ring-info/50",
  methodCardActiveSol:
    "border-primary bg-primary/10 ring-1 ring-primary/50",
  methodCardActiveEth:
    "border-secondary bg-secondary/10 ring-1 ring-secondary/50",
  methodCardActiveDefault:
    "border-primary bg-primary/10 ring-1 ring-primary/50",
  methodIconWrap:
    "grid size-8 shrink-0 place-items-center overflow-hidden rounded-full sm:size-9",
  methodIcon: "size-8 aspect-square sm:size-9",
  methodTitle: "block truncate font-semibold text-sm sm:text-base",
  methodTitleWrap: "min-w-0 flex-1 text-left",
  methodDetail: "text-base-content/60 text-xs leading-snug",
  methodDetailMobile: "block truncate text-xs text-base-content/55 sm:hidden",
  /** Limit / unavailable hint under a payment tile — visible at all breakpoints. */
  methodLimitHint: "block px-1 text-xs leading-snug text-base-content/55",
  methodDetailDesktop: "hidden",
  methodNetworkReveal:
    "rounded-box border border-base-300 bg-base-100/50 p-3",
  methodNetworkRevealDesktop: "mt-3 hidden sm:block",
  methodNetworkRevealMobile:
    "ml-4 border-l border-base-content/20 pl-3 sm:hidden",
  methodNetworkRevealMobileUsdt: "ml-4 border-l border-success/40 pl-3 sm:hidden",
  methodNetworkRevealMobileUsdc: "ml-4 border-l border-info/40 pl-3 sm:hidden",
  methodNetworkRevealAnim:
    "grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none sm:hidden",
  methodNetworkRevealAnimOpen: "mt-2 grid-rows-[1fr] opacity-100",
  methodNetworkRevealAnimClosed: "grid-rows-[0fr] opacity-0",
  methodNetworkRevealInner: "min-h-0 overflow-hidden",
  methodNetworkLayout:
    "grid gap-3 lg:grid-cols-[9rem_minmax(0,1fr)_8rem] lg:items-start",
  methodNetworkHeading: "text-sm font-semibold text-base-content m-0",
  methodNetworkHint: "mt-0.5 text-xs text-base-content/55 m-0",
  methodNetworkGrid:
    "grid grid-cols-1 gap-2 min-[390px]:grid-cols-3 items-start",
  methodNetworkButton:
    "btn h-11 min-h-11 w-full justify-start gap-2 rounded-field border-base-300 bg-base-200 px-3 text-sm text-base-content shadow-none hover:border-base-content/30 hover:bg-base-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
  methodNetworkButtonUnavailable:
    "btn h-11 min-h-11 w-full justify-start gap-2 rounded-field border-base-300 bg-base-200 px-3 text-sm text-base-content opacity-50 cursor-not-allowed shadow-none pointer-events-none",
  methodNetworkButtonActiveUsdt:
    "border-success bg-success/10 ring-1 ring-success/50",
  methodNetworkButtonActiveUsdc:
    "border-info bg-info/10 ring-1 ring-info/50",
  methodNetworkButtonActiveDefault:
    "border-primary bg-primary/10 ring-1 ring-primary/50",
  methodNetworkIcon: "size-6 shrink-0 aspect-square",
  methodNetworkCheck:
    "ml-auto grid size-5 place-items-center rounded-full bg-success text-[0.65rem] text-success-content",
  methodNetworkCheckUsdc:
    "ml-auto grid size-5 place-items-center rounded-full bg-info text-[0.65rem] text-info-content",
  methodNetworkSummary:
    "mt-2 flex items-center gap-1.5 text-xs text-base-content/65 m-0",
  methodNetworkSummaryIcon:
    "grid size-4 place-items-center rounded-full bg-success text-[0.65rem] text-success-content",
  methodNetworkSummaryIconUsdc:
    "grid size-4 place-items-center rounded-full bg-info text-[0.65rem] text-info-content",
  methodContinueRow: "mt-0 flex justify-end max-sm:block",
  methodConfirm: "btn btn-primary w-full sm:w-auto sm:min-w-32",
  methodConfirmDesktop: "btn btn-primary w-full",
  methodTile: "grid min-w-0 content-start gap-0.5",
  breadcrumbs: "breadcrumbs text-sm",
  breadcrumbCurrent: "font-bold",
  routePicker: "grid grid-cols-2 md:grid-cols-4 gap-2",
  routeButton:
    "card card-border bg-base-100 grid gap-1.5 content-start min-h-[120px] p-2.5 text-left cursor-pointer hover:border-primary",
  routeButtonSelected:
    "card card-border bg-base-100 grid gap-1.5 content-start min-h-[120px] p-2.5 text-left border-primary ring-2 ring-primary/30",
  countrySelect: "inline-flex items-center gap-2 text-xs font-bold",
  countrySelectLabel: "sr-only",
  countrySelectControl: "select select-bordered select-sm max-w-[min(280px,100%)]",
  wizardResults: "grid gap-2.5",
  wizardEmpty: "alert",
  wizardRoute: "grid gap-3",
  wizardRouteHeading: "flex flex-wrap items-center gap-2",
  providerGrid: "grid grid-cols-1 md:grid-cols-2 gap-2",
  providerCard:
    "card card-border bg-base-100 p-3 grid gap-2 items-center grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-2 md:gap-y-1",
  providerCardRecommended:
    "card card-border bg-base-100 p-3 grid gap-2 items-center grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-2 md:gap-y-1",
  providerHeading: "flex gap-2 items-center min-w-0",
  providerIcon: "rounded size-7 shrink-0",
  providerName: "font-semibold truncate m-0 min-w-0",
  providerBadge: "badge badge-ghost badge-sm whitespace-nowrap",
  providerKind: "text-base-content/60 text-sm m-0 justify-self-end text-right",
  providerActions: "col-span-2 flex w-full md:col-span-1 md:w-auto md:justify-self-end",
  providerOpen: "btn btn-soft btn-sm w-full md:w-auto",
  swapActions: "grid gap-2.5 grid-cols-1 md:grid-cols-3",
  swapAction: "grid gap-2",
  swapEstimate: "text-base-content/60 m-0 text-sm",
  swapWarning: "alert alert-warning text-sm",
  swapNetworkWarning: "alert alert-error alert-soft text-sm items-start gap-3",
  swapNetworkWarningIcon: "size-6 shrink-0 stroke-current",
  swapNetworkWarningContent: "grid gap-1 min-w-0",
  swapNetworkWarningTitle: "font-bold m-0",
  swapNetworkWarningBody: "m-0",
  swapNetworkWarningEmphasis: "font-bold underline",
  swapProgress: "text-base-content/60 m-0",
  swapInstruction: "m-0 text-base-content text-base font-bold text-center md:text-left",
  swapStart: "btn btn-soft",
  swapPanel: "grid gap-3",
  swapDepositLayout:
    "grid gap-3 md:grid-cols-[auto_minmax(0,1fr)] md:gap-x-5 md:items-start min-w-0",
  swapDepositSide: "grid gap-3 min-w-0 content-start",
  swapHeading: "flex flex-wrap gap-2 items-center justify-between",
  swapHeadingTitle: "text-lg font-semibold",
  swapHeadingDetail: "text-base-content/60",
  swapQr:
    "justify-self-center w-[min(200px,100%)] block h-auto md:justify-self-start md:w-[min(180px,100%)]",
  swapDetails: "grid gap-2 m-0",
  swapDetailsDt: "text-base-content/60 text-xs font-bold uppercase",
  swapDetailsDd: "grid gap-2 grid-cols-[minmax(0,1fr)_auto] items-center m-0",
  swapDetailsCode: "min-w-0 break-all font-mono text-sm",
  // Readonly select-all fields: keep the quiet resting border, suppress daisyUI's
  // focus outline+offset which otherwise reads as a double ring around selected text.
  swapDetailsInput:
    "input input-sm w-full min-w-0 font-mono text-sm outline-none! focus:outline-none! focus:outline-offset-0!",
  swapDetailsActions: "flex flex-wrap gap-2 justify-end",
  swapDetailsLink: "btn btn-sm btn-soft",
  swapBreakdown: "grid gap-2 py-2 border-t border-base-300",
  swapBreakdownTitle: "m-0 text-base-content/60 text-xs font-bold uppercase",
  swapBreakdownRows: "grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 items-baseline m-0",
  swapWaitingTitle: "flex items-baseline justify-between gap-3 min-w-0",
  swapCountdown: "shrink-0 text-base-content font-semibold tabular-nums",
  swapBack: "btn btn-sm btn-soft justify-self-start",
  swapSupport: "collapse collapse-arrow bg-base-200",
  swapSupportTitle: "collapse-title font-bold min-h-0 py-2",
  swapSupportContent: "collapse-content",
  transactionDetails: "collapse collapse-arrow bg-base-200",
  transactionDetailsTitle: "collapse-title font-bold min-h-0 py-2",
  transactionDetailsContent: "collapse-content",
  swapRefund: "grid gap-2",
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
  tutorialFrame: "flex items-center justify-center min-h-0 overflow-hidden rounded-box border border-base-300 bg-base-200",
  tutorialImage: "block w-auto max-w-full h-auto max-h-[min(66vh,720px)] object-contain",
  tutorialCaption: "m-0 text-base font-bold text-center",
  tutorialIntro: "grid gap-3 p-4 text-center",
  tutorialProviderLogo: "justify-self-center size-[52px] rounded",
  tutorialCopy: "btn btn-soft justify-self-center min-w-[min(240px,100%)]",
  tutorialCopyMessage: "text-success font-bold",
  tutorialProgress: "m-0 text-base-content/60 text-xs text-center",
  tutorialSteps: "flex gap-1.5 justify-center",
  tutorialStep: "badge badge-xs badge-ghost size-2 p-0",
  tutorialStepActive: "badge badge-xs badge-neutral size-2 p-0",
  tutorialControls: "grid grid-cols-2 gap-2",
  hostBridge: "block",
} as const;

export type OrClassKey = keyof typeof orClasses;
