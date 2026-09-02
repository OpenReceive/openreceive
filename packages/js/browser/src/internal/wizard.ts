import { getSwapRefundAddressError } from "@openreceive/core/swap-address";
import {
  type AssetIndexEntry,
  type AssetUrlResolver,
  getPaymentWizardRoutes,
  listAssets,
  payTutorialUrls,
  providerIconUrls,
  type PaymentWizardRoute,
  type Provider,
  type ResolvedProviderRef,
} from "@openreceive/provider-data";
import { formatSwapLimit } from "./checkout-format.ts";
import {
  type CheckoutPhase,
  type CheckoutPaymentMethod,
  type PaymentMethod,
  type PaymentMethodOption,
  type PaymentWizardController,
  type PaymentWizardControllerOptions,
  type PaymentWizardModel,
  type PaymentWizardRequest,
  type PaymentWizardSelection,
  type PaymentWizardSelectionAction,
  type PaymentWizardState,
  type WizardProviderDisplay,
  type WizardProviderTutorialDisplay,
  type WizardRouteAssetDisplay,
  type WizardRouteDisplay,
  type PaymentIconId,
  assetIconIds,
  checkoutLabels,
  paymentIconPaths,
  paymentIconUrls,
  paymentMethodIconIds,
  orClasses,
} from "./ui.ts";

/**
 * Provider icons and tutorial images are FILES the host has to be able to
 * serve; the packaged URLs only resolve under Vite/Rollup (see
 * `@openreceive/provider-data`'s `assetUrl`), so each display builder takes an
 * optional resolver and hands it the packaged PATH instead. Payment icons are
 * compiled into this package (`paymentIconUrls` are `data:` URIs), so they need
 * nothing from the host — but a resolver, when given, still wins: a host that
 * serves the files has chosen to, and a strict `img-src` without `data:` is
 * one reason to.
 */
function resolvePaymentIcon(id: PaymentIconId, resolveAssetUrl?: AssetUrlResolver): string {
  return resolveAssetUrl === undefined
    ? paymentIconUrls[id]
    : resolveAssetUrl(paymentIconPaths[id]);
}

export function getBitcoinAssets(): readonly AssetIndexEntry[] {
  return listAssets().filter((asset) => asset.symbol === "btc" && asset.route !== undefined);
}

function getDefaultBitcoinRoute(): string | null {
  const routes = [
    ...new Set(
      getBitcoinAssets().flatMap((asset) => (asset.route === undefined ? [] : [asset.route])),
    ),
  ];
  return routes.length === 1 ? (routes[0] ?? null) : null;
}

export function getPaymentStatusText(phase: CheckoutPhase): {
  readonly title: string;
  readonly detail: string;
} {
  if (phase === "settled") {
    return {
      title: checkoutLabels.paymentStatus.settledTitle,
      detail: checkoutLabels.paymentStatus.settledDetail,
    };
  }
  if (phase === "expired") {
    return {
      title: checkoutLabels.paymentStatus.expiredTitle,
      detail: checkoutLabels.paymentStatus.expiredDetail,
    };
  }
  return {
    title: checkoutLabels.paymentStatus.waitingTitle,
    detail: checkoutLabels.paymentStatus.waitingDetail,
  };
}

export function getWizardEmptyMessage(): string {
  return checkoutLabels.emptyBitcoin;
}

export function getCheckoutProviderOpenLabel(): string {
  return checkoutLabels.openProvider;
}

export function getCheckoutProviderIcon(
  provider: Pick<Provider, "icon_path">,
  resolveAssetUrl?: AssetUrlResolver,
): string {
  if (resolveAssetUrl !== undefined) return resolveAssetUrl(provider.icon_path);
  return providerIconUrls[provider.icon_path] ?? resolvePaymentIcon("crypto");
}

export function getCheckoutProviderTutorials(
  provider: Pick<Provider, "tutorials">,
  resolveAssetUrl?: AssetUrlResolver,
): readonly WizardProviderTutorialDisplay[] {
  return (provider.tutorials ?? []).map((tutorial) => ({
    index: tutorial.index,
    path: tutorial.path,
    image:
      resolveAssetUrl === undefined
        ? (payTutorialUrls[tutorial.path] ?? tutorial.path)
        : resolveAssetUrl(tutorial.path),
    caption: tutorial.caption,
  }));
}

export function getRouteNetworkLabel(routeId: string): string {
  return routeId === "lightning" || routeId === "btc-lightning"
    ? checkoutLabels.lightningNetwork
    : routeId;
}

export function createWizardRouteAssetDisplays(
  assets: readonly AssetIndexEntry[],
  options: {
    readonly selectedRoute?: string | null;
    /** Host-side rewrite of the packaged icon path. See {@link AssetUrlResolver}. */
    readonly resolveAssetUrl?: AssetUrlResolver;
  } = {},
): readonly WizardRouteAssetDisplay[] {
  return assets.map((asset) => {
    const id = asset.route ?? asset.symbol;
    const iconId = routeIconId(asset);
    return {
      id,
      label: asset.label,
      subtitle: getRouteNetworkLabel(id),
      icon: resolvePaymentIcon(iconId, options.resolveAssetUrl),
      iconId,
      iconPath: paymentIconPaths[iconId],
      selected: options.selectedRoute === id,
    };
  });
}

/**
 * The wallet suggestions for each route, as displays.
 *
 * The registry answers ~37 providers for Lightning. Both shipped renderers draw
 * all of them, in a grid on the route screen where that is fine; a host putting
 * them under the invoice instead — beside a QR, in a fixed-height panel — wants
 * `providerPreviewLimit` and a "show all" affordance built from
 * {@link WizardRouteDisplay.providerCount}. `OPENRECEIVE_PROVIDER_PREVIEW_LIMIT`
 * is the number the shipped styles are drawn against.
 *
 * No default limit, deliberately: the renderers show the whole grid, and a
 * default that silently hid 33 wallets from them would be a worse bug than the
 * one it prevents.
 */
export function createWizardRouteDisplays(
  routes: readonly PaymentWizardRoute[],
  options: {
    /** Draw at most this many providers per route. Omitted, every one is drawn. */
    readonly providerPreviewLimit?: number;
    /** Host-side rewrite of the packaged icon and tutorial paths. See {@link AssetUrlResolver}. */
    readonly resolveAssetUrl?: AssetUrlResolver;
  } = {},
): readonly WizardRouteDisplay[] {
  return routes.map((route) => ({
    key: getWizardRouteDisplayKey(route),
    title: getWizardRouteDisplayTitle(route),
    subtitle: getWizardRouteDisplaySubtitle(route),
    providers: (options.providerPreviewLimit === undefined
      ? route.providers
      : route.providers.slice(0, options.providerPreviewLimit)
    ).map((entry) => createWizardProviderDisplay(entry, options.resolveAssetUrl)),
    providerCount: route.providers.length,
  }));
}

function getWizardRouteDisplayKey(route: PaymentWizardRoute): string {
  return route.route.id;
}

function getWizardRouteDisplayTitle(route: PaymentWizardRoute): string {
  return route.route.label;
}

function getWizardRouteDisplaySubtitle(route: PaymentWizardRoute): string {
  return route.route.symbol.toUpperCase();
}

function createWizardProviderDisplay(
  entry: ResolvedProviderRef,
  resolveAssetUrl?: AssetUrlResolver,
): WizardProviderDisplay {
  return {
    id: entry.provider.id,
    name: entry.provider.name,
    kind: entry.provider.kind,
    url: entry.provider.lightning_docs_url ?? entry.provider.url,
    // Both the resolved URL and the packaged key: a host that serves these
    // files itself needs the key, and going back to `providerRegistry` for it
    // is not something a display-layer caller should have to know to do.
    icon: getCheckoutProviderIcon(entry.provider, resolveAssetUrl),
    iconPath: entry.provider.icon_path,
    tutorials: getCheckoutProviderTutorials(entry.provider, resolveAssetUrl),
    copyLabel: checkoutLabels.copyInvoice,
    copiedLabel: checkoutLabels.copied,
    openLabel: getCheckoutProviderOpenLabel(),
  };
}

// Each `get…Icon` getter answers a URL; its `get…IconId` twin answers the key
// behind it, which is what a renderer drawing `paymentIconSvgs` inline needs.
// Same decision, two representations — the id getters are the one place the
// mapping lives.

export function getPaymentMethodIconId(method: PaymentMethod): PaymentIconId {
  return paymentMethodIconIds[method];
}

export function getPaymentMethodIcon(
  method: PaymentMethod,
  resolveAssetUrl?: AssetUrlResolver,
): string {
  return resolvePaymentIcon(getPaymentMethodIconId(method), resolveAssetUrl);
}

function assetIconId(symbol: string): PaymentIconId {
  return assetIconIds[symbol] ?? "crypto";
}

/** Icon id for a swap network label (Tron → trx, Solana → sol, Ethereum → eth). */
export function getNetworkIconId(networkLabel: string): PaymentIconId {
  const key = networkLabel.trim().toLowerCase();
  if (key === "tron" || key === "trx") return "trx";
  if (key === "solana" || key === "sol") return "sol";
  if (key === "ethereum" || key === "eth") return "eth";
  return "crypto";
}

export function getNetworkIcon(networkLabel: string, resolveAssetUrl?: AssetUrlResolver): string {
  return resolvePaymentIcon(getNetworkIconId(networkLabel), resolveAssetUrl);
}

/**
 * Icon id for a swap pay-in option card. Always the token/coin mark (USDT,
 * USDC, SOL, …). Network marks (Tron/Solana/Ethereum) belong only in the
 * network reveal via {@link getNetworkIconId}.
 */
export function getSwapOptionIconId(option: { readonly label: string }): PaymentIconId {
  return assetIconId(option.label.trim().toLowerCase());
}

export function getSwapOptionIcon(
  option: { readonly label: string },
  resolveAssetUrl?: AssetUrlResolver,
): string {
  return resolvePaymentIcon(getSwapOptionIconId(option), resolveAssetUrl);
}

export interface SwapMethodGroup<T extends { readonly label: string }> {
  readonly label: string;
  readonly options: readonly T[];
}

/**
 * Collapse multi-network coins (e.g. USDT on Tron/Solana/Ethereum) into one method entry
 * with several network choices. Single-network coins stay as one-option groups.
 */
export function groupSwapOptionsByLabel<T extends { readonly label: string }>(
  options: readonly T[],
): readonly SwapMethodGroup<T>[] {
  const groups: SwapMethodGroup<T>[] = [];
  const indexByLabel = new Map<string, number>();
  for (const option of options) {
    const key = option.label.trim().toUpperCase();
    const existing = indexByLabel.get(key);
    if (existing === undefined) {
      indexByLabel.set(key, groups.length);
      groups.push({ label: option.label, options: [option] });
      continue;
    }
    const group = groups[existing];
    if (group === undefined) continue;
    groups[existing] = { label: group.label, options: [...group.options, option] };
  }
  return groups;
}

/**
 * Preferred checkout method-grid order when swap coins are present:
 * Bitcoin → USDT → USDC → SOL → ETH, then leftovers (including Crypto).
 */
export const OPENRECEIVE_METHOD_GRID_ORDER = [
  { kind: "method", id: "bitcoin" },
  { kind: "swap", label: "USDT" },
  { kind: "swap", label: "USDC" },
  { kind: "swap", label: "SOL" },
  { kind: "swap", label: "ETH" },
] as const;

export type MethodGridEntry<T extends { readonly label: string }> =
  | {
      readonly kind: "method";
      readonly method: PaymentMethodOption;
    }
  | {
      readonly kind: "swap";
      readonly group: SwapMethodGroup<T>;
    };

/**
 * Interleave payment methods with grouped swap coins in the preferred grid order.
 * When no swap options are present yet, returns the payment methods only.
 */
export function buildMethodGridEntries<T extends { readonly label: string }>(
  paymentMethods: readonly PaymentMethodOption[],
  swapOptions: readonly T[],
): readonly MethodGridEntry<T>[] {
  const swapGroups = groupSwapOptionsByLabel(swapOptions);
  if (swapGroups.length === 0) {
    return paymentMethods.map((method) => ({ kind: "method" as const, method }));
  }

  const methodsById = new Map(paymentMethods.map((method) => [method.id, method]));
  const groupsByLabel = new Map(
    swapGroups.map((group) => [group.label.trim().toUpperCase(), group] as const),
  );
  const usedMethodIds = new Set<string>();
  const usedSwapLabels = new Set<string>();
  const entries: MethodGridEntry<T>[] = [];

  for (const slot of OPENRECEIVE_METHOD_GRID_ORDER) {
    if (slot.kind === "method") {
      const method = methodsById.get(slot.id);
      if (method === undefined) continue;
      usedMethodIds.add(method.id);
      entries.push({ kind: "method", method });
      continue;
    }
    const group = groupsByLabel.get(slot.label);
    if (group === undefined) continue;
    usedSwapLabels.add(slot.label);
    entries.push({ kind: "swap", group });
  }

  for (const method of paymentMethods) {
    if (usedMethodIds.has(method.id)) continue;
    entries.push({ kind: "method", method });
  }
  for (const group of swapGroups) {
    const key = group.label.trim().toUpperCase();
    if (usedSwapLabels.has(key)) continue;
    entries.push({ kind: "swap", group });
  }
  return entries;
}

export type PaymentAccentId = "bitcoin" | "usdt" | "usdc" | "sol" | "eth" | "default";

export function swapPickerKey(label: string): string {
  return `swap:${label.trim().toUpperCase()}`;
}

export function parseMethodPickerKey(
  key: string,
): { readonly kind: "method"; readonly methodId: string } | null {
  if (!key.startsWith("method:")) return null;
  return { kind: "method", methodId: key.slice("method:".length) };
}

export function parseSwapPickerKey(
  key: string,
): { readonly kind: "swap"; readonly label: string } | null {
  if (!key.startsWith("swap:")) return null;
  return { kind: "swap", label: key.slice("swap:".length) };
}

export function paymentAccentId(labelOrMethodId: string): PaymentAccentId {
  const key = labelOrMethodId.trim().toLowerCase();
  if (key === "bitcoin" || key === "btc") return "bitcoin";
  if (key === "usdt") return "usdt";
  if (key === "usdc") return "usdc";
  if (key === "sol" || key === "solana") return "sol";
  if (key === "eth" || key === "ethereum") return "eth";
  return "default";
}

const assetActiveClassByAccent: Readonly<Record<PaymentAccentId, string>> = {
  bitcoin: orClasses.methodCardActiveBitcoin,
  usdt: orClasses.methodCardActiveUsdt,
  usdc: orClasses.methodCardActiveUsdc,
  sol: orClasses.methodCardActiveSol,
  eth: orClasses.methodCardActiveEth,
  default: orClasses.methodCardActiveDefault,
};

const networkActiveClassByAccent: Readonly<Record<"usdt" | "usdc" | "default", string>> = {
  usdt: orClasses.methodNetworkButtonActiveUsdt,
  usdc: orClasses.methodNetworkButtonActiveUsdc,
  default: orClasses.methodNetworkButtonActiveDefault,
};

export function assetButtonClasses(options: {
  readonly accent: PaymentAccentId;
  readonly selected: boolean;
  readonly disabled?: boolean;
}): string {
  const base = options.disabled ? orClasses.methodCardUnavailable : orClasses.methodCardReady;
  if (!options.selected || options.disabled) return base;
  return `${base} ${assetActiveClassByAccent[options.accent]}`;
}

export function networkButtonClasses(options: {
  readonly accent: PaymentAccentId;
  readonly selected: boolean;
  readonly disabled?: boolean;
}): string {
  if (options.disabled) return orClasses.methodNetworkButtonUnavailable;
  if (!options.selected) return orClasses.methodNetworkButton;
  const accent =
    options.accent === "usdt" || options.accent === "usdc" ? options.accent : "default";
  return `${orClasses.methodNetworkButton} ${networkActiveClassByAccent[accent]}`;
}

export function networkMobileRevealClasses(accent: PaymentAccentId): string {
  if (accent === "usdt") return orClasses.methodNetworkRevealMobileUsdt;
  if (accent === "usdc") return orClasses.methodNetworkRevealMobileUsdc;
  return orClasses.methodNetworkRevealMobile;
}

export function networkCheckClasses(accent: PaymentAccentId): string {
  return accent === "usdc" ? orClasses.methodNetworkCheckUsdc : orClasses.methodNetworkCheck;
}

export function networkSummaryIconClasses(accent: PaymentAccentId): string {
  return accent === "usdc"
    ? orClasses.methodNetworkSummaryIconUsdc
    : orClasses.methodNetworkSummaryIcon;
}

export function formatNetworkSummary(assetLabel: string, networkLabel: string): string {
  return checkoutLabels.networkSummary
    .replace("{asset}", assetLabel)
    .replace("{network}", networkLabel);
}

/**
 * The line under a coin tile's name: the networks that coin can arrive on,
 * "Tron · Solana · Ethereum".
 *
 * Both renderers read it here, so a tile can never list different networks from
 * the reveal panel underneath it. Duplicates are dropped rather than repeated:
 * two USDT_SOL rows from a provider catalog are one network to a payer.
 */
export function formatMethodNetworkDetail(
  options: readonly { readonly network_label: string }[],
): string {
  const labels: string[] = [];
  for (const option of options) {
    const label = option.network_label.trim();
    if (label.length > 0 && !labels.includes(label)) labels.push(label);
  }
  return labels.join(" · ");
}

export function formatChooseNetworkHeading(assetLabel: string): string {
  return checkoutLabels.chooseAssetNetwork.replace("{asset}", assetLabel);
}

/**
 * When switching between multi-network coins, reuse the prior network label if the
 * newly selected coin supports it. Otherwise clear that coin's network selection.
 */
export function resolvePreservedNetworkSelection<
  T extends {
    readonly pay_in_asset: string;
    readonly network_label: string;
    readonly available?: boolean;
  },
>(options: {
  readonly previousGroup: { readonly label: string; readonly options: readonly T[] } | undefined;
  readonly nextGroup: { readonly label: string; readonly options: readonly T[] };
  readonly selectedAssetByGroup: Readonly<Record<string, string>>;
}): string | undefined {
  const nextKey = options.nextGroup.label.trim().toUpperCase();
  const current = options.selectedAssetByGroup[nextKey];
  if (
    current !== undefined &&
    options.nextGroup.options.some(
      (option) => option.pay_in_asset === current && option.available !== false,
    )
  ) {
    return current;
  }

  const previous = options.previousGroup;
  if (previous === undefined) return undefined;
  const previousKey = previous.label.trim().toUpperCase();
  const previousAsset = options.selectedAssetByGroup[previousKey];
  if (previousAsset === undefined) return undefined;
  const previousOption = previous.options.find((option) => option.pay_in_asset === previousAsset);
  if (previousOption === undefined) return undefined;
  const match = options.nextGroup.options.find(
    (option) => option.network_label === previousOption.network_label && option.available !== false,
  );
  return match?.pay_in_asset;
}

/** The swap group a compact-selector picker key points at, when it is a swap key. */
export function findSwapGridGroup<T extends { readonly label: string }>(
  entries: readonly MethodGridEntry<T>[],
  pickerKey: string | null | undefined,
): SwapMethodGroup<T> | undefined {
  if (pickerKey === null || pickerKey === undefined) return undefined;
  const parsed = parseSwapPickerKey(pickerKey);
  if (parsed === null) return undefined;
  const entry = entries.find(
    (entry) => entry.kind === "swap" && entry.group.label.trim().toUpperCase() === parsed.label,
  );
  return entry?.kind === "swap" ? entry.group : undefined;
}

/**
 * Per-coin network selection after a picker tile is selected: keeps the coin's
 * own prior pick when still available, otherwise carries the previously
 * selected coin's network over when the new coin supports it (see
 * {@link resolvePreservedNetworkSelection}), otherwise clears the
 * coin's entry. Returns the map unchanged for non-swap keys and single-network
 * groups.
 */
export function updateSelectedSwapAssetByGroup<
  T extends {
    readonly label: string;
    readonly pay_in_asset: string;
    readonly network_label: string;
    readonly available?: boolean;
  },
>(options: {
  readonly entries: readonly MethodGridEntry<T>[];
  readonly nextKey: string;
  readonly previousKey: string | null;
  readonly selectedAssetByGroup: Readonly<Record<string, string>>;
}): Record<string, string> {
  const nextGroup = findSwapGridGroup(options.entries, options.nextKey);
  if (nextGroup === undefined || nextGroup.options.length <= 1) {
    return options.selectedAssetByGroup;
  }
  const previousGroup = findSwapGridGroup(options.entries, options.previousKey);
  const preserved = resolvePreservedNetworkSelection({
    previousGroup,
    nextGroup,
    selectedAssetByGroup: options.selectedAssetByGroup,
  });
  const groupKey = nextGroup.label.trim().toUpperCase();
  if (preserved === undefined) {
    const { [groupKey]: _removed, ...rest } = options.selectedAssetByGroup;
    return rest;
  }
  return { ...options.selectedAssetByGroup, [groupKey]: preserved };
}

/**
 * What a compact-selector tile click means, resolved once.
 *
 * The network question exists ONLY because a deposit address is
 * network-specific and a wrong send is unrecoverable — which is exactly why it
 * must not be asked when it is not a real question. A single-network group
 * therefore resolves to `start_swap`, not `choose_network`: the rule is data
 * here, so a custom UI cannot ask a group with one answer which answer it wants.
 */
export type WizardSelection<T extends { readonly label: string }> =
  | { readonly kind: "select_method"; readonly methodId: string }
  | { readonly kind: "start_swap"; readonly payInAsset: string }
  | {
      readonly kind: "choose_network";
      readonly group: SwapMethodGroup<T>;
      readonly groupKey: string;
      readonly heading: string;
      readonly panelId: string;
      readonly headingId: string;
      /**
       * The per-group choice map after the pick, from
       * {@link updateSelectedSwapAssetByGroup}: keyed by GROUP KEY
       * (`group.label` upper-cased), valued by the chosen option's
       * `pay_in_asset` — NOT its `network_label`. A deposit address is
       * network-specific, so the value has to be the thing that identifies the
       * address, and `pay_in_asset` is what every other seam here keys on.
       */
      readonly selectedAssetByGroup: Record<string, string>;
    }
  | { readonly kind: "none" };

/**
 * Resolve a picker key against the grid: which of the three things a tile click
 * can mean, with everything that arm needs already in hand.
 *
 * `previousKey` is the tile that was open before, so a carried-over network
 * choice resolves the same way it does in both shipped renderers.
 */
export function resolveWizardSelection<
  T extends {
    readonly label: string;
    readonly pay_in_asset: string;
    readonly network_label: string;
    readonly available?: boolean;
  },
>(options: {
  readonly pickerKey: string;
  readonly previousKey?: string | null;
  readonly entries: readonly MethodGridEntry<T>[];
  /** Keyed by group key, valued by the chosen option's `pay_in_asset`. */
  readonly selectedAssetByGroup?: Readonly<Record<string, string>>;
}): WizardSelection<T> {
  const methodPick = parseMethodPickerKey(options.pickerKey);
  if (methodPick !== null) return { kind: "select_method", methodId: methodPick.methodId };
  const group = findSwapGridGroup(options.entries, options.pickerKey);
  if (group === undefined) return { kind: "none" };
  const selectedAssetByGroup = options.selectedAssetByGroup ?? {};
  if (group.options.length <= 1) {
    // One network is not a question. Prefer an available option so a group whose
    // only entry is out of range resolves to `none` rather than starting a swap
    // the server will refuse.
    const option = group.options.find((entry) => entry.available !== false);
    if (option === undefined) return { kind: "none" };
    return { kind: "start_swap", payInAsset: option.pay_in_asset };
  }
  const groupKey = group.label.trim().toUpperCase();
  return {
    kind: "choose_network",
    group,
    groupKey,
    heading: formatChooseNetworkHeading(group.label),
    ...wizardNetworkGroupIds(groupKey),
    selectedAssetByGroup: updateSelectedSwapAssetByGroup({
      entries: options.entries,
      nextKey: options.pickerKey,
      previousKey: options.previousKey ?? null,
      selectedAssetByGroup,
    }),
  };
}

/** Invoice-side amount context for fiat swap-limit notes. */
export interface SwapLimitContext {
  readonly amount_msats: number;
  readonly fiat?: { readonly currency: string; readonly value: string };
}

/**
 * The generated DOM ids for one network group's disclosure panel and its
 * heading. ONE helper so `aria-controls` and `aria-labelledby` cannot disagree
 * — between the two renderers, or between the two ids inside one of them (the
 * element used to sanitize the panel id and not the heading id; React
 * sanitized neither).
 */
export function wizardNetworkGroupIds(groupKey: string): {
  readonly panelId: string;
  readonly headingId: string;
} {
  const slug = groupKey.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return { panelId: `network-panel-${slug}`, headingId: `network-heading-${slug}` };
}

/**
 * The out-of-range swap panel, as data. Both renderers build the same panel
 * from this: the element writes HTML, React writes elements, and neither one
 * owns the copy or the range arithmetic.
 */
export interface SwapUnavailableModel {
  readonly title: string;
  readonly detail: string;
  /** Accepted pay-in range, when the provider reported limits. */
  readonly range?: string;
  readonly hint: string;
}

export function createSwapUnavailableModel(
  option: Pick<
    CheckoutPaymentMethod,
    | "label"
    | "available"
    | "unavailable_reason"
    | "unavailable_message"
    | "minimum_invoice_amount_msats"
    | "maximum_invoice_amount_msats"
    | "minimum_pay_amount"
    | "maximum_pay_amount"
  >,
  checkout: SwapLimitContext | undefined,
): SwapUnavailableModel {
  const detail =
    swapOptionLimitMessage(option, checkout) ??
    option.unavailable_message ??
    checkoutLabels.swapUnavailableFallback.replace("{asset}", option.label);
  const range =
    option.minimum_pay_amount === undefined
      ? undefined
      : option.maximum_pay_amount === undefined
        ? checkoutLabels.swapUnavailableMinimumOnly
            .replace("{minimum}", option.minimum_pay_amount)
            .replace("{asset}", option.label)
        : checkoutLabels.swapUnavailableRange
            .replace("{minimum}", option.minimum_pay_amount)
            .replace("{maximum}", option.maximum_pay_amount)
            .replace("{asset}", option.label);
  return {
    title: checkoutLabels.swapUnavailableTitle.replace("{asset}", option.label),
    detail,
    ...(range === undefined ? {} : { range }),
    hint: checkoutLabels.swapUnavailableHint,
  };
}

/**
 * Short reason to show for an out-of-range swap asset. Prefers a fiat figure
 * ("Minimum amount $10.00") converted from the invoice-side limit using the
 * checkout's own rate, falling back to the pay-in asset's own units
 * ("Minimum 5 USDT") when the provider only reports pay-side limits, then to
 * the provider's generic message.
 */
export function swapOptionLimitMessage(
  option: Pick<
    CheckoutPaymentMethod,
    | "label"
    | "available"
    | "unavailable_reason"
    | "unavailable_message"
    | "minimum_invoice_amount_msats"
    | "maximum_invoice_amount_msats"
    | "minimum_pay_amount"
    | "maximum_pay_amount"
  >,
  checkout: SwapLimitContext | undefined,
): string | undefined {
  if (option.available !== false) return undefined;
  if (option.unavailable_reason === "amount_too_small") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatSwapLimit(checkout, option.minimum_invoice_amount_msats, "ceil");
    if (fiat !== undefined) return `Minimum amount ${fiat}`;
    if (option.minimum_pay_amount !== undefined) {
      return `Minimum ${option.minimum_pay_amount} ${option.label}`;
    }
  }
  if (option.unavailable_reason === "amount_too_large") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatSwapLimit(checkout, option.maximum_invoice_amount_msats, "floor");
    if (fiat !== undefined) return `Maximum amount ${fiat}`;
    if (option.maximum_pay_amount !== undefined) {
      return `Maximum ${option.maximum_pay_amount} ${option.label}`;
    }
  }
  return option.unavailable_message;
}

/**
 * The same limit as {@link swapOptionLimitMessage}, as ONE finished sentence:
 * "To pay with SOL, your cart total must be at least $2.43."
 *
 * `createSwapUnavailableModel` answers the case where the payer PICKED an
 * unavailable asset and lands on a pane, which has room for a title, a detail,
 * a range and a hint. A grid that disables the tile instead has nowhere to put
 * four parts and needs one line — for a tooltip, a caption, an `aria-label`.
 * Both are built from the same figures, so the tile and the pane cannot quote
 * different numbers.
 *
 * Returns `undefined` for an option that is available; for an unavailable one
 * it always returns something, falling back to the provider's own message and
 * then to the generic sentence, so a caption is never blank.
 *
 * @param options.label Override the asset name in the sentence — pass the GROUP
 *   label ("USDT") when the tile represents a group whose cheapest entry point
 *   came from {@link swapGroupLimitOption}, so the sentence names what the payer
 *   clicked rather than one network behind it.
 */
export function swapOptionLimitSentence(
  option: Pick<
    CheckoutPaymentMethod,
    | "label"
    | "available"
    | "unavailable_reason"
    | "unavailable_message"
    | "minimum_invoice_amount_msats"
    | "maximum_invoice_amount_msats"
    | "minimum_pay_amount"
    | "maximum_pay_amount"
  >,
  checkout: SwapLimitContext | undefined,
  options: { readonly label?: string } = {},
): string | undefined {
  if (option.available !== false) return undefined;
  const asset = options.label ?? option.label;
  const sentence = (template: string, amount: string): string =>
    template.replace("{asset}", asset).replaceAll("{amount}", amount);

  if (option.unavailable_reason === "amount_too_small") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatSwapLimit(checkout, option.minimum_invoice_amount_msats, "ceil");
    if (fiat !== undefined) return sentence(checkoutLabels.swapCartMinimumSentence, fiat);
    if (option.minimum_pay_amount !== undefined) {
      return sentence(checkoutLabels.swapPayMinimumSentence, option.minimum_pay_amount);
    }
  }
  if (option.unavailable_reason === "amount_too_large") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatSwapLimit(checkout, option.maximum_invoice_amount_msats, "floor");
    if (fiat !== undefined) return sentence(checkoutLabels.swapCartMaximumSentence, fiat);
    if (option.maximum_pay_amount !== undefined) {
      return sentence(checkoutLabels.swapPayMaximumSentence, option.maximum_pay_amount);
    }
  }
  return (
    option.unavailable_message ?? checkoutLabels.swapUnavailableFallback.replace("{asset}", asset)
  );
}

/** Prefer the lowest invoice-side floor when every network in a group is unavailable. */
export function swapGroupLimitOption<
  T extends {
    readonly available?: boolean;
    readonly unavailable_reason?: string;
    readonly minimum_invoice_amount_msats?: number;
  },
>(options: readonly T[]): T | undefined {
  if (options.length === 0) return undefined;
  const unavailable = options.filter((option) => option.available === false);
  const tooSmall = unavailable.filter((option) => option.unavailable_reason === "amount_too_small");
  const candidates =
    tooSmall.length > 0 ? tooSmall : unavailable.length > 0 ? unavailable : options;
  let best = candidates[0];
  for (const option of candidates) {
    if (best === undefined) {
      best = option;
      continue;
    }
    const bestMin = best.minimum_invoice_amount_msats;
    const optionMin = option.minimum_invoice_amount_msats;
    if (optionMin === undefined) continue;
    if (bestMin === undefined || optionMin < bestMin) best = option;
  }
  return best;
}

/** One method-grid tile, as data. */
export type MethodGridDisplayEntry<T extends { readonly label: string }> =
  | {
      readonly kind: "method";
      readonly method: PaymentMethodOption;
      readonly accent: PaymentAccentId;
      readonly disabled: boolean;
    }
  | { readonly kind: "swap"; readonly group: MethodGridGroupDisplay<T> };

/**
 * One coin's tile in the method grid, with every derivation both renderers used
 * to redo by hand.
 *
 * `needsNetworkStep` and `startPayInAsset` are the `options.length > 1` rule as
 * DATA: a tile either opens the network step or starts a swap outright, and a
 * renderer picking between two DOM attributes never re-derives which.
 */
export interface MethodGridGroupDisplay<T extends { readonly label: string }> {
  readonly label: string;
  /** The group's normalized key — how `selectedAssetByGroup` is keyed. */
  readonly groupKey: string;
  readonly pickerKey: string;
  readonly accent: PaymentAccentId;
  readonly options: readonly T[];
  readonly multiNetwork: boolean;
  /** This tile is the open one in the compact selector. */
  readonly selected: boolean;
  /** A swap on one of this group's networks is being started right now. */
  readonly starting: boolean;
  /** Every network in the group is out of range for this cart. */
  readonly disabled: boolean;
  /** The option the tile's icon and title stand for. */
  readonly displayOption: T;
  /** The payer's pick when there is one, else {@link displayOption}. */
  readonly activeOption: T;
  readonly selectedOption?: T;
  /**
   * The SHORT tile message ("Minimum amount $2.71"), present only when the tile
   * is disabled — the pane's full sentence is a different string, deliberately
   * (see `swapOptionLimitSentence`).
   */
  readonly limitMessage?: string;
  readonly panelId: string;
  readonly headingId: string;
  readonly heading: string;
  readonly needsNetworkStep: boolean;
  readonly startPayInAsset?: string;
}

/** The compact selector's Continue button, as data. */
export interface MethodGridContinueDisplay {
  readonly payInAsset: string;
  readonly disabled: boolean;
  /** This exact asset is the one being started. */
  readonly starting: boolean;
  /** Finished copy: the limit message, "Preparing payment", or "Continue". */
  readonly label: string;
}

/**
 * The method grid as a display model — the last pane on the headless surface
 * that had none (routes have `createWizardRouteDisplays`, the deposit panel
 * `createSwapDisplayModel`, status `createCheckoutStatusModel`).
 */
export interface MethodGridDisplay<T extends { readonly label: string }> {
  readonly entries: readonly MethodGridDisplayEntry<T>[];
  /** A swap start is in flight, so every tile is inert. */
  readonly gridBusy: boolean;
  /** The open tile has more than one network, so a choice is still owed. */
  readonly networkRequired: boolean;
  readonly selectedGroup?: MethodGridGroupDisplay<T>;
  readonly continueTarget?: MethodGridContinueDisplay;
  readonly canContinue: boolean;
}

/**
 * Build the method grid's display model from the grid entries plus the three
 * pieces of renderer state (which tile is open, which network each coin is set
 * to, which asset is starting) and the invoice-side amount the limit notes are
 * quoted against.
 */
export function createMethodGridDisplay<
  T extends {
    readonly label: string;
    readonly pay_in_asset: string;
    readonly network_label: string;
    readonly available: boolean;
    readonly unavailable_reason?: string;
    readonly unavailable_message?: string;
    readonly minimum_pay_amount?: string;
    readonly maximum_pay_amount?: string;
    readonly minimum_invoice_amount_msats?: number;
    readonly maximum_invoice_amount_msats?: number;
  },
>(options: {
  readonly entries: readonly MethodGridEntry<T>[];
  readonly selectedPickerKey?: string | null;
  /** Keyed by group key, valued by the chosen option's `pay_in_asset`. */
  readonly selectedAssetByGroup?: Readonly<Record<string, string>>;
  /** The asset whose swap is being started, or null/undefined for none. */
  readonly startingAsset?: string | null;
  readonly checkout?: SwapLimitContext;
}): MethodGridDisplay<T> {
  const selectedKey = options.selectedPickerKey ?? null;
  const selectedAssetByGroup = options.selectedAssetByGroup ?? {};
  const startingAsset =
    options.startingAsset === null || options.startingAsset === ""
      ? undefined
      : options.startingAsset;
  const gridBusy = startingAsset !== undefined;

  const entries: MethodGridDisplayEntry<T>[] = [];
  for (const entry of options.entries) {
    if (entry.kind === "method") {
      entries.push({
        kind: "method",
        method: entry.method,
        accent: paymentAccentId(entry.method.id),
        disabled: gridBusy,
      });
      continue;
    }
    const group = entry.group;
    const displayOption =
      group.options.find((option) => option.available !== false) ?? group.options[0];
    // An empty group has no tile to draw; both renderers already bailed here.
    if (displayOption === undefined) continue;
    const groupKey = group.label.trim().toUpperCase();
    const multiNetwork = group.options.length > 1;
    const selectedAsset = selectedAssetByGroup[groupKey];
    const selectedOption =
      selectedAsset === undefined
        ? undefined
        : group.options.find((option) => option.pay_in_asset === selectedAsset);
    const activeOption = selectedOption ?? displayOption;
    const disabled = group.options.every((option) => option.available === false);
    const limitOption = disabled
      ? (swapGroupLimitOption(group.options) ?? activeOption)
      : activeOption;
    entries.push({
      kind: "swap",
      group: {
        label: group.label,
        groupKey,
        pickerKey: swapPickerKey(group.label),
        accent: paymentAccentId(group.label),
        options: group.options,
        multiNetwork,
        selected: selectedKey === swapPickerKey(group.label),
        starting: group.options.some((option) => option.pay_in_asset === startingAsset),
        disabled,
        displayOption,
        activeOption,
        ...(selectedOption === undefined ? {} : { selectedOption }),
        ...(() => {
          const limitMessage = swapOptionLimitMessage(limitOption, options.checkout);
          return limitMessage === undefined ? {} : { limitMessage };
        })(),
        ...wizardNetworkGroupIds(groupKey),
        heading: formatChooseNetworkHeading(group.label),
        needsNetworkStep: multiNetwork,
        ...(multiNetwork ? {} : { startPayInAsset: displayOption.pay_in_asset }),
      },
    });
  }

  const selectedGroup = entries.find(
    (entry): entry is Extract<MethodGridDisplayEntry<T>, { kind: "swap" }> =>
      entry.kind === "swap" && entry.group.pickerKey === selectedKey,
  )?.group;
  const networkRequired = selectedGroup?.multiNetwork === true;
  const selectedNetworkOption = selectedGroup?.selectedOption;
  const continueTarget =
    selectedNetworkOption === undefined
      ? undefined
      : buildContinueDisplay(selectedNetworkOption, {
          gridBusy,
          startingAsset,
          checkout: options.checkout,
        });

  return {
    entries,
    gridBusy,
    networkRequired,
    ...(selectedGroup === undefined ? {} : { selectedGroup }),
    ...(continueTarget === undefined ? {} : { continueTarget }),
    canContinue: continueTarget !== undefined && !continueTarget.disabled,
  };
}

function buildContinueDisplay<
  T extends Pick<
    CheckoutPaymentMethod,
    | "label"
    | "pay_in_asset"
    | "available"
    | "unavailable_reason"
    | "unavailable_message"
    | "minimum_pay_amount"
    | "maximum_pay_amount"
    | "minimum_invoice_amount_msats"
    | "maximum_invoice_amount_msats"
  >,
>(
  option: T,
  context: {
    readonly gridBusy: boolean;
    readonly startingAsset: string | undefined;
    readonly checkout: SwapLimitContext | undefined;
  },
): MethodGridContinueDisplay {
  const outOfRange = option.available === false;
  const starting = option.pay_in_asset === context.startingAsset;
  const limitMessage = swapOptionLimitMessage(option, context.checkout);
  return {
    payInAsset: option.pay_in_asset,
    disabled: outOfRange || context.gridBusy,
    starting,
    label:
      outOfRange && limitMessage !== undefined
        ? limitMessage
        : starting
          ? checkoutLabels.preparingPayment
          : checkoutLabels.continue,
  };
}

/**
 * Payer-facing validation for a swap refund address, shared by every refund
 * form: an empty address prompts for one, anything else is checked against the
 * pay-in asset's address format.
 */
export function getSwapRefundFormError(
  payInAsset: string,
  address: string,
  networkLabel: string,
): string | undefined {
  if (address.length === 0) return "Enter a refund address.";
  return getSwapRefundAddressError(payInAsset, address, networkLabel);
}

export function getRouteIcon(
  asset: Pick<AssetIndexEntry, "route" | "symbol">,
  resolveAssetUrl?: AssetUrlResolver,
): string {
  return resolvePaymentIcon(routeIconId(asset), resolveAssetUrl);
}

/**
 * The PACKAGED key behind {@link getRouteIcon}, for a host serving the files
 * itself. Parity with `WizardProviderDisplay.iconPath`: the display row carries
 * the key so nothing has to go back to the registry for it.
 */
export function getRouteIconPath(asset: Pick<AssetIndexEntry, "route" | "symbol">): string {
  return paymentIconPaths[routeIconId(asset)];
}

function routeIconId(asset: Pick<AssetIndexEntry, "route" | "symbol">): PaymentIconId {
  const routeId = asset.route ?? asset.symbol;
  if (asset.symbol === "btc" && routeId.includes("lightning")) return "lightning";
  return assetIconId(asset.symbol);
}

export function createPaymentWizardState(request: PaymentWizardRequest): PaymentWizardState {
  const selectedRouteId =
    request.selectedMethod === "bitcoin"
      ? (request.selectedBitcoinRoute ?? getDefaultBitcoinRoute())
      : null;
  const routes = selectedRouteId === null ? [] : getPaymentWizardRoutes({ route: selectedRouteId });

  return {
    selectedRouteId,
    routes,
  };
}

export function createPaymentWizardSelection(): PaymentWizardSelection {
  return {
    selectedMethod: null,
    selectedBitcoinRoute: null,
  };
}

export function createPaymentWizardModel(selection: PaymentWizardSelection): PaymentWizardModel {
  const wizard = createPaymentWizardState({
    selectedMethod: selection.selectedMethod,
    selectedBitcoinRoute: selection.selectedBitcoinRoute,
  });
  const routeAssets = selection.selectedMethod === "bitcoin" ? getBitcoinAssets() : [];
  const selectedRoute = wizard.selectedRouteId;

  return {
    selection,
    wizard,
    routeAssets,
    selectedRoute,
  };
}

export function updatePaymentWizardSelection(
  selection: PaymentWizardSelection,
  action: PaymentWizardSelectionAction,
): PaymentWizardSelection {
  switch (action.type) {
    case "select_method": {
      return {
        ...selection,
        selectedMethod: action.method,
        selectedBitcoinRoute:
          action.method === "bitcoin"
            ? (selection.selectedBitcoinRoute ?? getDefaultBitcoinRoute())
            : selection.selectedBitcoinRoute,
      };
    }
    case "change_method": {
      return {
        ...selection,
        selectedMethod: null,
        selectedBitcoinRoute: null,
      };
    }
    case "change_route": {
      if (selection.selectedMethod === "bitcoin") {
        return {
          ...selection,
          selectedBitcoinRoute: null,
        };
      }
      return selection;
    }
    case "select_route": {
      if (selection.selectedMethod === "bitcoin") {
        return {
          ...selection,
          selectedBitcoinRoute: action.route,
        };
      }
      return selection;
    }
  }
}

export class BrowserPaymentWizardController implements PaymentWizardController {
  private readonly options: PaymentWizardControllerOptions;
  private selection: PaymentWizardSelection;

  constructor(options: PaymentWizardControllerOptions = {}) {
    this.options = options;
    this.selection = options.selection ?? createPaymentWizardSelection();
  }

  getSelection(): PaymentWizardSelection {
    return this.selection;
  }

  getModel(): PaymentWizardModel {
    return createPaymentWizardModel(this.selection);
  }

  update(action: PaymentWizardSelectionAction): PaymentWizardSelection {
    const next = updatePaymentWizardSelection(this.selection, action);
    this.selection = next;
    this.options.onSelection?.(next);
    return next;
  }

  selectMethod(method: PaymentMethod): PaymentWizardSelection {
    return this.update({
      type: "select_method",
      method,
    });
  }

  changeMethod(): PaymentWizardSelection {
    return this.update({
      type: "change_method",
    });
  }

  selectRoute(route: string): PaymentWizardSelection {
    return this.update({
      type: "select_route",
      route,
    });
  }
}

export function createPaymentWizardController(
  options: PaymentWizardControllerOptions = {},
): PaymentWizardController {
  return new BrowserPaymentWizardController(options);
}
