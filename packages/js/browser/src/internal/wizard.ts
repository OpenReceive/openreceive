import {
  listAssets,
  getPaymentWizardRoutes,
  openReceivePayTutorialUrls,
  openReceiveProviderIconUrls,
  type AssetIndexEntry,
  type PaymentWizardRoute,
  type Provider,
  type ResolvedProviderRef,
} from "@openreceive/provider-data";
import {
  openReceiveAssetIconIds,
  openReceiveCheckoutLabels,
  openReceivePaymentIconUrls,
  openReceivePaymentMethodIconIds,
  orClasses,
  type CheckoutPhase,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentMethodOption,
  type OpenReceivePaymentWizardController,
  type OpenReceivePaymentWizardControllerOptions,
  type OpenReceivePaymentWizardModel,
  type OpenReceivePaymentWizardRequest,
  type OpenReceivePaymentWizardSelection,
  type OpenReceivePaymentWizardSelectionAction,
  type OpenReceivePaymentWizardState,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveWizardProviderTutorialDisplay,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardRouteDisplay,
} from "./ui.ts";

export function getOpenReceiveBitcoinAssets(): readonly AssetIndexEntry[] {
  return listAssets().filter((asset) => asset.symbol === "btc" && asset.route !== undefined);
}

function getOpenReceiveDefaultBitcoinRoute(): string | null {
  const routes = [
    ...new Set(
      getOpenReceiveBitcoinAssets().flatMap((asset) =>
        asset.route === undefined ? [] : [asset.route],
      ),
    ),
  ];
  return routes.length === 1 ? (routes[0] ?? null) : null;
}

export function getOpenReceiveAltcoinAssets(): readonly AssetIndexEntry[] {
  return listAssets().filter(
    (asset) =>
      asset.route !== undefined &&
      asset.symbol !== "btc" &&
      !["usd", "eur", "gbp"].includes(asset.symbol),
  );
}

export function getOpenReceivePaymentStatusText(phase: CheckoutPhase): {
  readonly title: string;
  readonly detail: string;
} {
  if (phase === "settled") {
    return {
      title: openReceiveCheckoutLabels.paymentStatus.settledTitle,
      detail: openReceiveCheckoutLabels.paymentStatus.settledDetail,
    };
  }
  if (phase === "expired") {
    return {
      title: openReceiveCheckoutLabels.paymentStatus.expiredTitle,
      detail: openReceiveCheckoutLabels.paymentStatus.expiredDetail,
    };
  }
  return {
    title: openReceiveCheckoutLabels.paymentStatus.waitingTitle,
    detail: openReceiveCheckoutLabels.paymentStatus.waitingDetail,
  };
}

export function getOpenReceiveWizardEmptyMessage(method: OpenReceivePaymentMethod | null): string {
  return method === "crypto"
    ? openReceiveCheckoutLabels.emptyCrypto
    : openReceiveCheckoutLabels.emptyBitcoin;
}

export function getCheckoutProviderOpenLabel(): string {
  return openReceiveCheckoutLabels.openProvider;
}

export function getCheckoutProviderIcon(provider: Pick<Provider, "icon_path">): string {
  return openReceiveProviderIconUrls[provider.icon_path] ?? openReceivePaymentIconUrls.crypto;
}

export function getCheckoutProviderTutorials(
  provider: Pick<Provider, "tutorials">,
): readonly OpenReceiveWizardProviderTutorialDisplay[] {
  return (provider.tutorials ?? []).map((tutorial) => ({
    index: tutorial.index,
    path: tutorial.path,
    image: openReceivePayTutorialUrls[tutorial.path] ?? tutorial.path,
    caption: tutorial.caption,
  }));
}

export function getOpenReceiveRouteNetworkLabel(routeId: string): string {
  return routeId === "lightning" || routeId === "btc-lightning"
    ? openReceiveCheckoutLabels.lightningNetwork
    : routeId;
}

export function createOpenReceiveWizardRouteAssetDisplays(
  assets: readonly AssetIndexEntry[],
  options: {
    readonly selectedRoute?: string | null;
  } = {},
): readonly OpenReceiveWizardRouteAssetDisplay[] {
  return assets.map((asset) => {
    const id = asset.route ?? asset.symbol;
    return {
      id,
      label: asset.label,
      subtitle: getOpenReceiveRouteNetworkLabel(id),
      icon: getOpenReceiveRouteIcon(asset),
      selected: options.selectedRoute === id,
    };
  });
}

export function createOpenReceiveWizardRouteDisplays(
  routes: readonly PaymentWizardRoute[],
  options: {
    readonly providerPreviewLimit?: number;
  } = {},
): readonly OpenReceiveWizardRouteDisplay[] {
  return routes.map((route) => ({
    key: getOpenReceiveWizardRouteDisplayKey(route),
    title: getOpenReceiveWizardRouteDisplayTitle(route),
    subtitle: getOpenReceiveWizardRouteDisplaySubtitle(route),
    providers: (options.providerPreviewLimit === undefined
      ? route.providers
      : route.providers.slice(0, options.providerPreviewLimit)
    ).map((entry) => createOpenReceiveWizardProviderDisplay(entry)),
  }));
}

function getOpenReceiveWizardRouteDisplayKey(route: PaymentWizardRoute): string {
  return route.kind === "crypto" ? route.route.id : `${route.rail.id}:${route.country.code}`;
}

function getOpenReceiveWizardRouteDisplayTitle(route: PaymentWizardRoute): string {
  return route.kind === "crypto" ? route.route.label : route.rail.label;
}

function getOpenReceiveWizardRouteDisplaySubtitle(route: PaymentWizardRoute): string {
  return route.kind === "crypto" ? route.route.symbol.toUpperCase() : route.country.currency;
}

function createOpenReceiveWizardProviderDisplay(
  entry: ResolvedProviderRef,
): OpenReceiveWizardProviderDisplay {
  return {
    id: entry.provider.id,
    name: entry.provider.name,
    kind: entry.provider.kind,
    url: entry.provider.lightning_docs_url ?? entry.provider.url,
    icon: getCheckoutProviderIcon(entry.provider),
    tutorials: getCheckoutProviderTutorials(entry.provider),
    copyLabel: openReceiveCheckoutLabels.copyInvoice,
    copiedLabel: openReceiveCheckoutLabels.copied,
    openLabel: getCheckoutProviderOpenLabel(),
  };
}

export function getOpenReceivePaymentMethodIcon(method: OpenReceivePaymentMethod): string {
  return openReceivePaymentIconUrls[openReceivePaymentMethodIconIds[method]];
}

export function getOpenReceiveAssetIcon(symbol: string): string {
  return openReceivePaymentIconUrls[openReceiveAssetIconIds[symbol] ?? "crypto"];
}

/** Icon for a swap network label (Tron → trx, Solana → sol, Ethereum → eth). */
export function getOpenReceiveNetworkIcon(networkLabel: string): string {
  const key = networkLabel.trim().toLowerCase();
  if (key === "tron" || key === "trx") return openReceivePaymentIconUrls.trx;
  if (key === "solana" || key === "sol") return openReceivePaymentIconUrls.sol;
  if (key === "ethereum" || key === "eth") return openReceivePaymentIconUrls.eth;
  return openReceivePaymentIconUrls.crypto;
}

/**
 * Icon for a swap pay-in option card. Always the token/coin mark (USDT, USDC, SOL, …).
 * Network marks (Tron/Solana/Ethereum) belong only in the network reveal via
 * {@link getOpenReceiveNetworkIcon}.
 */
export function getOpenReceiveSwapOptionIcon(option: {
  readonly label: string;
  readonly network_label?: string;
}): string {
  return getOpenReceiveAssetIcon(option.label.trim().toLowerCase());
}

export interface OpenReceiveSwapMethodGroup<T extends { readonly label: string }> {
  readonly label: string;
  readonly options: readonly T[];
}

/**
 * Collapse multi-network coins (e.g. USDT on Tron/Solana/Ethereum) into one method entry
 * with several network choices. Single-network coins stay as one-option groups.
 */
export function groupOpenReceiveSwapOptionsByLabel<T extends { readonly label: string }>(
  options: readonly T[],
): readonly OpenReceiveSwapMethodGroup<T>[] {
  const groups: OpenReceiveSwapMethodGroup<T>[] = [];
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

export type OpenReceiveMethodGridEntry<T extends { readonly label: string }> =
  | {
      readonly kind: "method";
      readonly method: OpenReceivePaymentMethodOption;
    }
  | {
      readonly kind: "swap";
      readonly group: OpenReceiveSwapMethodGroup<T>;
    };

/**
 * Interleave payment methods with grouped swap coins in the preferred grid order.
 * The standalone "Crypto" method is never shown — swap coins replace it when present.
 * When no swap options are present yet, returns Bitcoin (and any other non-crypto methods) only.
 */
export function buildOpenReceiveMethodGridEntries<T extends { readonly label: string }>(
  paymentMethods: readonly OpenReceivePaymentMethodOption[],
  swapOptions: readonly T[],
): readonly OpenReceiveMethodGridEntry<T>[] {
  const visibleMethods = paymentMethods.filter((method) => method.id !== "crypto");
  const swapGroups = groupOpenReceiveSwapOptionsByLabel(swapOptions);
  if (swapGroups.length === 0) {
    return visibleMethods.map((method) => ({ kind: "method" as const, method }));
  }

  const methodsById = new Map(visibleMethods.map((method) => [method.id, method]));
  const groupsByLabel = new Map(
    swapGroups.map((group) => [group.label.trim().toUpperCase(), group] as const),
  );
  const usedMethodIds = new Set<string>();
  const usedSwapLabels = new Set<string>();
  const entries: OpenReceiveMethodGridEntry<T>[] = [];

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

  for (const method of visibleMethods) {
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

export type OpenReceivePaymentAccentId = "bitcoin" | "usdt" | "usdc" | "sol" | "eth" | "default";

export function openReceiveMethodPickerKey(methodId: string): string {
  return `method:${methodId}`;
}

export function openReceiveSwapPickerKey(label: string): string {
  return `swap:${label.trim().toUpperCase()}`;
}

export function parseOpenReceiveMethodPickerKey(
  key: string,
): { readonly kind: "method"; readonly methodId: string } | null {
  if (!key.startsWith("method:")) return null;
  return { kind: "method", methodId: key.slice("method:".length) };
}

export function parseOpenReceiveSwapPickerKey(
  key: string,
): { readonly kind: "swap"; readonly label: string } | null {
  if (!key.startsWith("swap:")) return null;
  return { kind: "swap", label: key.slice("swap:".length) };
}

export function openReceivePaymentAccentId(labelOrMethodId: string): OpenReceivePaymentAccentId {
  const key = labelOrMethodId.trim().toLowerCase();
  if (key === "bitcoin" || key === "btc") return "bitcoin";
  if (key === "usdt") return "usdt";
  if (key === "usdc") return "usdc";
  if (key === "sol" || key === "solana") return "sol";
  if (key === "eth" || key === "ethereum") return "eth";
  return "default";
}

const assetActiveClassByAccent: Readonly<Record<OpenReceivePaymentAccentId, string>> = {
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

export function openReceiveAssetButtonClasses(options: {
  readonly accent: OpenReceivePaymentAccentId;
  readonly selected: boolean;
  readonly disabled?: boolean;
}): string {
  const base = options.disabled ? orClasses.methodCardUnavailable : orClasses.methodCardReady;
  if (!options.selected || options.disabled) return base;
  return `${base} ${assetActiveClassByAccent[options.accent]}`;
}

export function openReceiveNetworkButtonClasses(options: {
  readonly accent: OpenReceivePaymentAccentId;
  readonly selected: boolean;
  readonly disabled?: boolean;
}): string {
  if (options.disabled) return orClasses.methodNetworkButtonUnavailable;
  if (!options.selected) return orClasses.methodNetworkButton;
  const accent =
    options.accent === "usdt" || options.accent === "usdc" ? options.accent : "default";
  return `${orClasses.methodNetworkButton} ${networkActiveClassByAccent[accent]}`;
}

export function openReceiveNetworkMobileRevealClasses(accent: OpenReceivePaymentAccentId): string {
  if (accent === "usdt") return orClasses.methodNetworkRevealMobileUsdt;
  if (accent === "usdc") return orClasses.methodNetworkRevealMobileUsdc;
  return orClasses.methodNetworkRevealMobile;
}

export function openReceiveNetworkCheckClasses(accent: OpenReceivePaymentAccentId): string {
  return accent === "usdc" ? orClasses.methodNetworkCheckUsdc : orClasses.methodNetworkCheck;
}

export function openReceiveNetworkSummaryIconClasses(accent: OpenReceivePaymentAccentId): string {
  return accent === "usdc"
    ? orClasses.methodNetworkSummaryIconUsdc
    : orClasses.methodNetworkSummaryIcon;
}

export function formatOpenReceiveNetworkSummary(assetLabel: string, networkLabel: string): string {
  return openReceiveCheckoutLabels.networkSummary
    .replace("{asset}", assetLabel)
    .replace("{network}", networkLabel);
}

export function formatOpenReceiveChooseNetworkHeading(assetLabel: string): string {
  return openReceiveCheckoutLabels.chooseAssetNetwork.replace("{asset}", assetLabel);
}

/**
 * When switching between multi-network coins, reuse the prior network label if the
 * newly selected coin supports it. Otherwise clear that coin's network selection.
 */
export function resolveOpenReceivePreservedNetworkSelection<
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

export function getOpenReceiveRouteIcon(asset: Pick<AssetIndexEntry, "route" | "symbol">): string {
  const routeId = asset.route ?? asset.symbol;
  if (asset.symbol === "btc" && routeId.includes("lightning")) {
    return openReceivePaymentIconUrls.lightning;
  }
  return getOpenReceiveAssetIcon(asset.symbol);
}

export function createOpenReceivePaymentWizardState(
  request: OpenReceivePaymentWizardRequest,
): OpenReceivePaymentWizardState {
  const selectedRouteId =
    request.selectedMethod === "bitcoin"
      ? (request.selectedBitcoinRoute ?? getOpenReceiveDefaultBitcoinRoute())
      : request.selectedMethod === "crypto"
        ? (request.selectedCryptoRoute ?? null)
        : null;
  const routes = selectedRouteId === null ? [] : getPaymentWizardRoutes({ route: selectedRouteId });

  return {
    selectedRouteId,
    routes,
  };
}

export function createOpenReceivePaymentWizardSelection(): OpenReceivePaymentWizardSelection {
  return {
    selectedMethod: null,
    selectedBitcoinRoute: null,
    selectedCryptoRoute: null,
  };
}

export function createOpenReceivePaymentWizardModel(
  selection: OpenReceivePaymentWizardSelection,
): OpenReceivePaymentWizardModel {
  const wizard = createOpenReceivePaymentWizardState({
    selectedMethod: selection.selectedMethod,
    selectedBitcoinRoute: selection.selectedBitcoinRoute,
    selectedCryptoRoute: selection.selectedCryptoRoute,
  });
  const routeAssets =
    selection.selectedMethod === "bitcoin"
      ? getOpenReceiveBitcoinAssets()
      : selection.selectedMethod === "crypto"
        ? getOpenReceiveAltcoinAssets()
        : [];
  const selectedRoute = wizard.selectedRouteId;

  return {
    selection,
    wizard,
    routeAssets,
    selectedRoute,
  };
}

export function updateOpenReceivePaymentWizardSelection(
  selection: OpenReceivePaymentWizardSelection,
  action: OpenReceivePaymentWizardSelectionAction,
): OpenReceivePaymentWizardSelection {
  switch (action.type) {
    case "select_method": {
      return {
        ...selection,
        selectedMethod: action.method,
        selectedBitcoinRoute:
          action.method === "bitcoin"
            ? (selection.selectedBitcoinRoute ?? getOpenReceiveDefaultBitcoinRoute())
            : selection.selectedBitcoinRoute,
      };
    }
    case "change_method": {
      return {
        ...selection,
        selectedMethod: null,
        selectedBitcoinRoute: null,
        selectedCryptoRoute: null,
      };
    }
    case "change_route": {
      if (selection.selectedMethod === "bitcoin") {
        return {
          ...selection,
          selectedBitcoinRoute: null,
        };
      }
      if (selection.selectedMethod === "crypto") {
        return {
          ...selection,
          selectedCryptoRoute: null,
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
      if (selection.selectedMethod === "crypto") {
        return {
          ...selection,
          selectedCryptoRoute: action.route,
        };
      }
      return selection;
    }
  }
}

export class OpenReceiveBrowserPaymentWizardController
  implements OpenReceivePaymentWizardController
{
  private readonly options: OpenReceivePaymentWizardControllerOptions;
  private selection: OpenReceivePaymentWizardSelection;

  constructor(options: OpenReceivePaymentWizardControllerOptions = {}) {
    this.options = options;
    this.selection = options.selection ?? createOpenReceivePaymentWizardSelection();
  }

  getSelection(): OpenReceivePaymentWizardSelection {
    return this.selection;
  }

  getModel(): OpenReceivePaymentWizardModel {
    return createOpenReceivePaymentWizardModel(this.selection);
  }

  update(action: OpenReceivePaymentWizardSelectionAction): OpenReceivePaymentWizardSelection {
    const next = updateOpenReceivePaymentWizardSelection(this.selection, action);
    this.selection = next;
    this.options.onSelection?.(next);
    return next;
  }

  selectMethod(method: OpenReceivePaymentMethod): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_method",
      method,
    });
  }

  changeMethod(): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "change_method",
    });
  }

  selectRoute(route: string): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_route",
      route,
    });
  }
}

export function createOpenReceivePaymentWizardController(
  options: OpenReceivePaymentWizardControllerOptions = {},
): OpenReceivePaymentWizardController {
  return new OpenReceiveBrowserPaymentWizardController(options);
}
