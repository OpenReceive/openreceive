import { getSwapRefundAddressError } from "@openreceive/core/swap-address";
import {
  type AssetIndexEntry,
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
  assetIconIds,
  checkoutLabels,
  paymentIconUrls,
  paymentMethodIconIds,
  orClasses,
} from "./ui.ts";

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

export function getCheckoutProviderIcon(provider: Pick<Provider, "icon_path">): string {
  return providerIconUrls[provider.icon_path] ?? paymentIconUrls.crypto;
}

export function getCheckoutProviderTutorials(
  provider: Pick<Provider, "tutorials">,
): readonly WizardProviderTutorialDisplay[] {
  return (provider.tutorials ?? []).map((tutorial) => ({
    index: tutorial.index,
    path: tutorial.path,
    image: payTutorialUrls[tutorial.path] ?? tutorial.path,
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
  } = {},
): readonly WizardRouteAssetDisplay[] {
  return assets.map((asset) => {
    const id = asset.route ?? asset.symbol;
    return {
      id,
      label: asset.label,
      subtitle: getRouteNetworkLabel(id),
      icon: getRouteIcon(asset),
      selected: options.selectedRoute === id,
    };
  });
}

export function createWizardRouteDisplays(
  routes: readonly PaymentWizardRoute[],
  options: {
    readonly providerPreviewLimit?: number;
  } = {},
): readonly WizardRouteDisplay[] {
  return routes.map((route) => ({
    key: getWizardRouteDisplayKey(route),
    title: getWizardRouteDisplayTitle(route),
    subtitle: getWizardRouteDisplaySubtitle(route),
    providers: (options.providerPreviewLimit === undefined
      ? route.providers
      : route.providers.slice(0, options.providerPreviewLimit)
    ).map((entry) => createWizardProviderDisplay(entry)),
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

function createWizardProviderDisplay(entry: ResolvedProviderRef): WizardProviderDisplay {
  return {
    id: entry.provider.id,
    name: entry.provider.name,
    kind: entry.provider.kind,
    url: entry.provider.lightning_docs_url ?? entry.provider.url,
    icon: getCheckoutProviderIcon(entry.provider),
    tutorials: getCheckoutProviderTutorials(entry.provider),
    copyLabel: checkoutLabels.copyInvoice,
    copiedLabel: checkoutLabels.copied,
    openLabel: getCheckoutProviderOpenLabel(),
  };
}

export function getPaymentMethodIcon(method: PaymentMethod): string {
  return paymentIconUrls[paymentMethodIconIds[method]];
}

export function getAssetIcon(symbol: string): string {
  return paymentIconUrls[assetIconIds[symbol] ?? "crypto"];
}

/** Icon for a swap network label (Tron → trx, Solana → sol, Ethereum → eth). */
export function getNetworkIcon(networkLabel: string): string {
  const key = networkLabel.trim().toLowerCase();
  if (key === "tron" || key === "trx") return paymentIconUrls.trx;
  if (key === "solana" || key === "sol") return paymentIconUrls.sol;
  if (key === "ethereum" || key === "eth") return paymentIconUrls.eth;
  return paymentIconUrls.crypto;
}

/**
 * Icon for a swap pay-in option card. Always the token/coin mark (USDT, USDC, SOL, …).
 * Network marks (Tron/Solana/Ethereum) belong only in the network reveal via
 * {@link getNetworkIcon}.
 */
export function getSwapOptionIcon(option: {
  readonly label: string;
  readonly network_label?: string;
}): string {
  return getAssetIcon(option.label.trim().toLowerCase());
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
  readonly selectedNetworks: Readonly<Record<string, string>>;
}): string | undefined {
  const nextKey = options.nextGroup.label.trim().toUpperCase();
  const current = options.selectedNetworks[nextKey];
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
  const previousAsset = options.selectedNetworks[previousKey];
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
export function updateSelectedSwapNetworks<
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
  readonly selectedNetworks: Readonly<Record<string, string>>;
}): Record<string, string> {
  const nextGroup = findSwapGridGroup(options.entries, options.nextKey);
  if (nextGroup === undefined || nextGroup.options.length <= 1) {
    return options.selectedNetworks;
  }
  const previousGroup = findSwapGridGroup(options.entries, options.previousKey);
  const preserved = resolvePreservedNetworkSelection({
    previousGroup,
    nextGroup,
    selectedNetworks: options.selectedNetworks,
  });
  const groupKey = nextGroup.label.trim().toUpperCase();
  if (preserved === undefined) {
    const { [groupKey]: _removed, ...rest } = options.selectedNetworks;
    return rest;
  }
  return { ...options.selectedNetworks, [groupKey]: preserved };
}

/** Invoice-side amount context for fiat swap-limit notes. */
export interface SwapLimitContext {
  readonly amount_msats: number;
  readonly fiat?: { readonly currency: string; readonly value: string };
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

export function getRouteIcon(asset: Pick<AssetIndexEntry, "route" | "symbol">): string {
  const routeId = asset.route ?? asset.symbol;
  if (asset.symbol === "btc" && routeId.includes("lightning")) {
    return paymentIconUrls.lightning;
  }
  return getAssetIcon(asset.symbol);
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
