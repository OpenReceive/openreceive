import {
  getAssets,
  getCountries,
  getCountryRoutes,
  getPaymentWizardRoutes,
  openReceivePayTutorialUrls,
  openReceiveProviderIconUrls,
  type AssetIndexEntry,
  type Country,
  type FiatRailId,
  type PaymentWizardRoute,
  type Provider,
  type ResolvedProviderRef,
} from "@openreceive/provider-data";
import { readOpenReceiveStoredCountryCode, writeOpenReceiveStoredCountryCode } from "./theme.ts";
import {
  OPENRECEIVE_COUNTRY_MAP_HEIGHT,
  OPENRECEIVE_COUNTRY_MAP_WIDTH,
  openReceiveAssetIconIds,
  openReceiveCheckoutLabels,
  openReceivePaymentIconUrls,
  openReceivePaymentMethodIconIds,
  openReceiveRegionLabels,
  openReceiveRegionOrder,
  type CheckoutPhase,
  type OpenReceiveCountryDisplay,
  type OpenReceiveCountryMapPin,
  type OpenReceiveCountryPickerModel,
  type OpenReceiveCountryPickerModelRequest,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentMethodOption,
  type OpenReceivePaymentWizardController,
  type OpenReceivePaymentWizardControllerOptions,
  type OpenReceivePaymentWizardModel,
  type OpenReceivePaymentWizardRequest,
  type OpenReceivePaymentWizardSelection,
  type OpenReceivePaymentWizardSelectionAction,
  type OpenReceivePaymentWizardState,
  type OpenReceiveRegionId,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveWizardProviderTutorialDisplay,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardRouteDisplay,
} from "./ui.ts";

export function parseOpenReceiveRegion(value: string | null): OpenReceiveRegionId | null {
  return openReceiveRegionOrder.includes(value as OpenReceiveRegionId)
    ? (value as OpenReceiveRegionId)
    : null;
}

export const openReceiveCountryMapRegions = [
  {
    id: "north-america",
    cx: 180,
    cy: 125,
    rx: 150,
    ry: 78,
  },
  {
    id: "latin-america",
    cx: 265,
    cy: 260,
    rx: 82,
    ry: 130,
  },
  {
    id: "europe",
    cx: 425,
    cy: 145,
    rx: 105,
    ry: 64,
  },
  {
    id: "africa",
    cx: 455,
    cy: 255,
    rx: 76,
    ry: 102,
  },
  {
    id: "middle-east",
    cx: 535,
    cy: 213,
    rx: 78,
    ry: 58,
  },
  {
    id: "asia-pacific",
    cx: 655,
    cy: 215,
    rx: 165,
    ry: 120,
  },
] as const satisfies ReadonlyArray<{
  readonly id: OpenReceiveRegionId;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}>;

export const openReceiveCountryPins: Readonly<Record<string, OpenReceiveCountryMapPin>> = {
  AR: { region: "latin-america", coordinates: [-64, -34] },
  AU: { region: "asia-pacific", coordinates: [134, -25] },
  BD: { region: "asia-pacific", coordinates: [90, 24] },
  BR: { region: "latin-america", coordinates: [-52, -10] },
  CA: { region: "north-america", coordinates: [-106, 56] },
  CH: { region: "europe", coordinates: [8, 47] },
  CL: { region: "latin-america", coordinates: [-71, -30] },
  CO: { region: "latin-america", coordinates: [-74, 4] },
  DE: { region: "europe", coordinates: [10, 51] },
  EG: { region: "africa", coordinates: [30, 27] },
  ES: { region: "europe", coordinates: [-4, 40] },
  FR: { region: "europe", coordinates: [2, 47] },
  GB: { region: "europe", coordinates: [-2, 54] },
  GH: { region: "africa", coordinates: [-1, 8] },
  IE: { region: "europe", coordinates: [-8, 53] },
  ID: { region: "asia-pacific", coordinates: [118, -2] },
  IN: { region: "asia-pacific", coordinates: [78, 22] },
  IT: { region: "europe", coordinates: [12, 43] },
  JP: { region: "asia-pacific", coordinates: [138, 37] },
  KE: { region: "africa", coordinates: [38, 0] },
  KR: { region: "asia-pacific", coordinates: [128, 36] },
  MX: { region: "latin-america", coordinates: [-102, 23] },
  NG: { region: "africa", coordinates: [8, 9] },
  NL: { region: "europe", coordinates: [5, 52] },
  PH: { region: "asia-pacific", coordinates: [122, 13] },
  PK: { region: "asia-pacific", coordinates: [70, 30] },
  PL: { region: "europe", coordinates: [19, 52] },
  PT: { region: "europe", coordinates: [-8, 39] },
  SA: { region: "middle-east", coordinates: [45, 24] },
  SG: { region: "asia-pacific", coordinates: [104, 1.3] },
  SV: { region: "latin-america", coordinates: [-89, 13.8] },
  TH: { region: "asia-pacific", coordinates: [101, 15] },
  TR: { region: "middle-east", coordinates: [35, 39] },
  UA: { region: "europe", coordinates: [31, 49] },
  US: { region: "north-america", coordinates: [-98, 39] },
  VE: { region: "latin-america", coordinates: [-66, 7] },
  VN: { region: "asia-pacific", coordinates: [108, 16] },
  ZA: { region: "africa", coordinates: [24, -29] },
  AE: { region: "middle-east", coordinates: [54, 24] },
};

export function getOpenReceiveDefaultCountryCode(): string {
  return (
    getCountries().find((country) => country.code === "US")?.code ?? getCountries()[0]?.code ?? ""
  );
}

export function getOpenReceiveBitcoinAssets(): readonly AssetIndexEntry[] {
  return getAssets().filter((asset) => asset.symbol === "btc" && asset.route !== undefined);
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
  return getAssets().filter(
    (asset) =>
      asset.route !== undefined &&
      asset.symbol !== "btc" &&
      !["usd", "eur", "gbp"].includes(asset.symbol),
  );
}

export function getOpenReceiveRegionForCountry(countryCode: string): OpenReceiveRegionId {
  return openReceiveCountryPins[countryCode]?.region ?? "north-america";
}

export function formatOpenReceiveCountryMetaLabel(country: Country): string {
  return country.currency;
}

export function createOpenReceiveCountryDisplay(
  country: Country,
  options: { readonly selectedCountryCode?: string } = {},
): OpenReceiveCountryDisplay {
  return {
    country,
    code: country.code,
    label: country.name,
    metaLabel: formatOpenReceiveCountryMetaLabel(country),
    selected: country.code === options.selectedCountryCode,
  };
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
  if (method === "bitcoin") return openReceiveCheckoutLabels.emptyBitcoin;
  if (method === "crypto") return openReceiveCheckoutLabels.emptyCrypto;
  return openReceiveCheckoutLabels.emptyFiat;
}

export function getCheckoutProviderUsBadge(us: boolean | null): string | null {
  void us;
  return null;
}

export function getCheckoutProviderOpenLabel(providerName: string): string {
  void providerName;
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
    recommended: entry.flagship,
    recommendedLabel: entry.flagship ? openReceiveCheckoutLabels.recommended : null,
    usBadge: null,
    copyLabel: openReceiveCheckoutLabels.copyInvoice,
    copiedLabel: openReceiveCheckoutLabels.copied,
    openLabel: getCheckoutProviderOpenLabel(entry.provider.name),
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
 * Network marks (Tron/Solana/Ethereum) belong only in the network dropdown via
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
 * When no swap options are present, returns the payment methods only.
 */
export function buildOpenReceiveMethodGridEntries<T extends { readonly label: string }>(
  paymentMethods: readonly OpenReceivePaymentMethodOption[],
  swapOptions: readonly T[],
): readonly OpenReceiveMethodGridEntry<T>[] {
  const swapGroups = groupOpenReceiveSwapOptionsByLabel(swapOptions);
  if (swapGroups.length === 0) {
    return paymentMethods.map((method) => ({ kind: "method" as const, method }));
  }

  const methodsById = new Map(paymentMethods.map((method) => [method.id, method]));
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

  for (const method of paymentMethods) {
    if (method.id === "crypto" || usedMethodIds.has(method.id)) continue;
    entries.push({ kind: "method", method });
  }
  for (const group of swapGroups) {
    const key = group.label.trim().toUpperCase();
    if (usedSwapLabels.has(key)) continue;
    entries.push({ kind: "swap", group });
  }
  return entries;
}

export function getOpenReceiveRouteIcon(asset: Pick<AssetIndexEntry, "route" | "symbol">): string {
  const routeId = asset.route ?? asset.symbol;
  if (asset.symbol === "btc" && routeId.includes("lightning")) {
    return openReceivePaymentIconUrls.lightning;
  }
  return getOpenReceiveAssetIcon(asset.symbol);
}

export function getOpenReceiveCountriesForRail(rail: FiatRailId): readonly Country[] {
  return getCountries()
    .filter(
      (country) =>
        openReceiveCountryPins[country.code] !== undefined &&
        getCountryRoutes(country.code).some((route) => route.rail.id === rail),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export function projectOpenReceiveCountryMapPoint(
  coordinates: readonly [number, number],
  options: {
    readonly width?: number;
    readonly height?: number;
  } = {},
): readonly [number, number] {
  const width = options.width ?? OPENRECEIVE_COUNTRY_MAP_WIDTH;
  const height = options.height ?? OPENRECEIVE_COUNTRY_MAP_HEIGHT;
  const longitude = Math.max(-180, Math.min(180, coordinates[0]));
  const latitude = Math.max(-85, Math.min(85, coordinates[1]));
  return [((longitude + 180) / 360) * width, ((85 - latitude) / 170) * height];
}

export function createOpenReceiveCountryPickerModel(
  request: OpenReceiveCountryPickerModelRequest,
): OpenReceiveCountryPickerModel {
  const selectedCountry = request.countries.find(
    (country) => country.code === request.selectedCountryCode,
  );
  const hoveredCountry =
    request.hoveredCountryCode === undefined || request.hoveredCountryCode === null
      ? undefined
      : request.countries.find((country) => country.code === request.hoveredCountryCode);
  const visibleRegionCountries = request.countries.filter(
    (country) => getOpenReceiveRegionForCountry(country.code) === request.selectedRegion,
  );
  const selectedCountryDisplay =
    selectedCountry === undefined
      ? undefined
      : createOpenReceiveCountryDisplay(selectedCountry, {
          selectedCountryCode: request.selectedCountryCode,
        });
  const hoveredCountryDisplay =
    hoveredCountry === undefined
      ? undefined
      : createOpenReceiveCountryDisplay(hoveredCountry, {
          selectedCountryCode: request.selectedCountryCode,
        });
  const visibleRegionCountryDisplays = visibleRegionCountries.map((country) =>
    createOpenReceiveCountryDisplay(country, {
      selectedCountryCode: request.selectedCountryCode,
    }),
  );
  const regions = openReceiveRegionOrder.map((region) => {
    const count = request.countries.filter(
      (country) => getOpenReceiveRegionForCountry(country.code) === region,
    ).length;
    return {
      id: region,
      label: openReceiveRegionLabels[region],
      count,
      enabled: count > 0,
      selected: region === request.selectedRegion,
    };
  });
  const mapCountries = request.countries.flatMap((country) => {
    const pin = openReceiveCountryPins[country.code];
    if (pin === undefined) return [];
    return [
      {
        country,
        region: pin.region,
        coordinates: pin.coordinates,
        point: projectOpenReceiveCountryMapPoint(pin.coordinates),
        selected: country.code === request.selectedCountryCode,
        hovered: country.code === request.hoveredCountryCode,
        label: country.name,
        metaLabel: formatOpenReceiveCountryMetaLabel(country),
      },
    ];
  });

  return {
    countries: request.countries,
    regions,
    selectedCountry,
    hoveredCountry,
    ...(selectedCountryDisplay === undefined ? {} : { selectedCountryDisplay }),
    ...(hoveredCountryDisplay === undefined ? {} : { hoveredCountryDisplay }),
    readoutLabel:
      hoveredCountryDisplay?.label ??
      selectedCountryDisplay?.label ??
      openReceiveCheckoutLabels.chooseCountry,
    ...((hoveredCountryDisplay ?? selectedCountryDisplay) === undefined
      ? {}
      : { readoutMetaLabel: (hoveredCountryDisplay ?? selectedCountryDisplay)?.metaLabel }),
    visibleRegionCountries,
    visibleRegionCountryDisplays,
    mapCountries,
  };
}

export function createOpenReceivePaymentWizardState(
  request: OpenReceivePaymentWizardRequest,
): OpenReceivePaymentWizardState {
  const selectedRail = getRailForPaymentMethod(request.selectedMethod);
  const railCountries = selectedRail === null ? [] : getOpenReceiveCountriesForRail(selectedRail);
  const selectedCountry =
    request.selectedCountryCode === undefined
      ? railCountries[0]
      : (railCountries.find((country) => country.code === request.selectedCountryCode) ??
        railCountries[0]);
  const selectedRouteId =
    request.selectedMethod === "bitcoin"
      ? (request.selectedBitcoinRoute ?? getOpenReceiveDefaultBitcoinRoute())
      : request.selectedMethod === "crypto"
        ? (request.selectedCryptoRoute ?? null)
        : null;
  const routes =
    selectedRail !== null && selectedCountry !== undefined
      ? getPaymentWizardRoutes({
          country: selectedCountry.code,
          rail: selectedRail,
        })
      : selectedRouteId === null
        ? []
        : getPaymentWizardRoutes({ route: selectedRouteId });

  return {
    selectedRail,
    ...(selectedCountry === undefined ? {} : { selectedCountry }),
    railCountries,
    selectedRouteId,
    routes,
  };
}

function getRailForPaymentMethod(_method: OpenReceivePaymentMethod | null): FiatRailId | null {
  return null;
}

export function createOpenReceivePaymentWizardSelection(
  options: {
    readonly storedCountryCode?: string | null;
    readonly defaultCountryCode?: string;
  } = {},
): OpenReceivePaymentWizardSelection {
  const selectedCountryCode =
    options.storedCountryCode ?? options.defaultCountryCode ?? getOpenReceiveDefaultCountryCode();
  return {
    selectedMethod: null,
    selectedCountryCode,
    selectedBitcoinRoute: null,
    selectedCryptoRoute: null,
    selectedRegion: getOpenReceiveRegionForCountry(selectedCountryCode),
    countryPickerOpen:
      options.storedCountryCode === undefined ? true : options.storedCountryCode === null,
  };
}

export function createOpenReceivePaymentWizardModel(
  selection: OpenReceivePaymentWizardSelection,
): OpenReceivePaymentWizardModel {
  const wizard = createOpenReceivePaymentWizardState({
    selectedMethod: selection.selectedMethod,
    selectedCountryCode: selection.selectedCountryCode,
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
  const countryPicker = createOpenReceiveCountryPickerModel({
    countries: wizard.railCountries,
    selectedCountryCode: selection.selectedCountryCode,
    selectedRegion: selection.selectedRegion,
  });
  const countryDisplays = wizard.railCountries.map((country) =>
    createOpenReceiveCountryDisplay(country, {
      selectedCountryCode: selection.selectedCountryCode,
    }),
  );

  return {
    selection,
    wizard,
    countryPicker,
    countryDisplays,
    visibleRegionCountries: countryPicker.visibleRegionCountries,
    visibleRegionCountryDisplays: countryPicker.visibleRegionCountryDisplays,
    ...(countryPicker.selectedCountryDisplay === undefined
      ? {}
      : { selectedCountryDisplay: countryPicker.selectedCountryDisplay }),
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
        countryPickerOpen: false,
      };
    }
    case "change_method": {
      return {
        ...selection,
        selectedMethod: null,
        selectedBitcoinRoute: null,
        selectedCryptoRoute: null,
        countryPickerOpen: false,
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
    case "select_region": {
      const nextSelection = {
        ...selection,
        selectedRegion: action.region,
      };
      const regionCountries = createOpenReceivePaymentWizardModel(
        nextSelection,
      ).wizard.railCountries.filter(
        (country) => getOpenReceiveRegionForCountry(country.code) === action.region,
      );
      if (regionCountries.some((country) => country.code === selection.selectedCountryCode)) {
        return nextSelection;
      }
      const first = regionCountries[0];
      return first === undefined
        ? nextSelection
        : {
            ...nextSelection,
            selectedCountryCode: first.code,
          };
    }
    case "select_country": {
      return {
        ...selection,
        selectedCountryCode: action.countryCode,
        selectedRegion: getOpenReceiveRegionForCountry(action.countryCode),
        countryPickerOpen: false,
      };
    }
    case "open_country_picker": {
      return {
        ...selection,
        countryPickerOpen: true,
      };
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
    this.selection =
      options.selection ??
      createOpenReceivePaymentWizardSelection({
        storedCountryCode:
          options.storedCountryCode ??
          readOpenReceiveStoredCountryCode({
            storage: options.storage,
            storageKey: options.storageKey,
          }),
        defaultCountryCode: options.defaultCountryCode,
      });
  }

  getSelection(): OpenReceivePaymentWizardSelection {
    return this.selection;
  }

  getModel(): OpenReceivePaymentWizardModel {
    return createOpenReceivePaymentWizardModel(this.selection);
  }

  update(action: OpenReceivePaymentWizardSelectionAction): OpenReceivePaymentWizardSelection {
    const next = updateOpenReceivePaymentWizardSelection(this.selection, action);
    if (action.type === "select_country") {
      writeOpenReceiveStoredCountryCode(action.countryCode, {
        storage: this.options.storage,
        storageKey: this.options.storageKey,
      });
    }
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

  selectRegion(region: OpenReceiveRegionId): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_region",
      region,
    });
  }

  selectCountry(countryCode: string): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_country",
      countryCode,
    });
  }

  openCountryPicker(): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "open_country_picker",
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
