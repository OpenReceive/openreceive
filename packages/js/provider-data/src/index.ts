import providerRegistryJson from "./data/openreceive-providers.v4.json" with { type: "json" };

export type CountryCoverage = "deep" | "thin" | "sparse";
export type ProviderId = string;
export type CryptoRouteId = string;
export type FiatRailId = string;
export type CountryCode = string;

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly url: string;
  readonly us: boolean | null;
  readonly lightning_docs_url: string | null;
  readonly icon_path: string;
  readonly tutorials?: readonly ProviderTutorial[];
}

export interface ProviderTutorial {
  readonly index: number;
  readonly path: string;
  readonly caption: string;
}

export interface ProviderRef {
  readonly provider: ProviderId;
  readonly flagship?: boolean;
  readonly rank?: number;
}

export interface AssetIndexEntry {
  readonly symbol: string;
  readonly label: string;
  readonly route?: CryptoRouteId;
}

export interface CryptoRoute {
  readonly id: CryptoRouteId;
  readonly symbol: string;
  readonly label: string;
  readonly providers: readonly ProviderRef[];
}

export interface Country {
  readonly code: CountryCode;
  readonly name: string;
  readonly currency: string;
  readonly coverage: CountryCoverage;
}

export interface FiatRail {
  readonly label: string;
  readonly countries: Readonly<Record<CountryCode, readonly ProviderRef[]>>;
}

export type ResolvedFiatRail = FiatRail & { readonly id: FiatRailId };

export interface DisqualifiedProvider {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly reason: string;
}

export interface ProviderRegistry {
  readonly schema_version: "4.0.0";
  readonly generated: string;
  readonly description: string;
  readonly filter: string;
  readonly _meta: Record<string, unknown>;
  readonly assets_index: readonly AssetIndexEntry[];
  readonly providers: Readonly<Record<ProviderId, Provider>>;
  readonly crypto_routes: readonly CryptoRoute[];
  readonly countries: readonly Country[];
  readonly fiat_rails: Readonly<Record<FiatRailId, FiatRail>>;
  readonly disqualified_providers: readonly DisqualifiedProvider[];
}

export interface ResolvedProviderRef {
  readonly provider: Provider;
  readonly flagship: boolean;
  readonly rank?: number;
}

export interface ProviderFilter {
  readonly us?: boolean | null;
}

export interface CountryFilter {
  readonly currency?: string;
  readonly coverage?: CountryCoverage;
}

export interface ResolvedCountryRoute {
  readonly rail: ResolvedFiatRail;
  readonly country: Country;
  readonly providers: readonly ResolvedProviderRef[];
}

export interface PaymentWizardRouteRequest {
  readonly asset?: string;
  readonly country?: CountryCode;
  readonly rail?: FiatRailId;
  readonly route?: CryptoRouteId;
}

export interface PaymentWizardCryptoRoute {
  readonly kind: "crypto";
  readonly route: CryptoRoute;
  readonly providers: readonly ResolvedProviderRef[];
  readonly asset?: AssetIndexEntry;
}

export interface PaymentWizardFiatRoute {
  readonly kind: "fiat";
  readonly rail: ResolvedFiatRail;
  readonly country: Country;
  readonly providers: readonly ResolvedProviderRef[];
}

export type PaymentWizardRoute = PaymentWizardCryptoRoute | PaymentWizardFiatRoute;

export interface ProviderRegistryValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }

  return value;
}

const registry = deepFreeze(structuredClone(providerRegistryJson)) as ProviderRegistry;

function sortByProviderName(left: Provider, right: Provider): number {
  return left.name.localeCompare(right.name, "en");
}

function resolveProviderRef(ref: ProviderRef): ResolvedProviderRef {
  const provider = registry.providers[ref.provider];
  if (!provider) {
    throw new Error(`provider registry references unknown provider: ${ref.provider}`);
  }

  return {
    provider,
    flagship: ref.flagship === true,
    ...(ref.rank === undefined ? {} : { rank: ref.rank })
  };
}

function resolveProviderRefs(refs: readonly ProviderRef[]): readonly ResolvedProviderRef[] {
  return refs.map(resolveProviderRef);
}

function normalizeAssetSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

function normalizeCountryCode(countryCode: CountryCode): CountryCode {
  return countryCode.trim().toUpperCase();
}

function normalizeRouteId(routeId: CryptoRouteId): CryptoRouteId {
  return routeId.trim().toLowerCase();
}

function normalizeRailId(railId: FiatRailId): FiatRailId {
  return railId.trim().toLowerCase();
}

function toPaymentWizardFiatRoute(route: ResolvedCountryRoute): PaymentWizardFiatRoute {
  return {
    kind: "fiat",
    rail: route.rail,
    country: route.country,
    providers: route.providers
  };
}

export const providerRegistry: ProviderRegistry = registry;

export function getProviderRegistryMetadata() {
  return {
    schema_version: registry.schema_version,
    generated: registry.generated,
    description: registry.description,
    filter: registry.filter
  };
}

export function listProviders(filter: ProviderFilter = {}): readonly Provider[] {
  return Object.values(registry.providers)
    .filter((provider) => filter.us === undefined || provider.us === filter.us)
    .sort(sortByProviderName);
}

export const getProviders = listProviders;

export function getProvider(providerId: ProviderId): Provider | undefined {
  return registry.providers[providerId];
}

export function listAssets(): readonly AssetIndexEntry[] {
  return registry.assets_index;
}

export const getAssets = listAssets;

export function getAsset(symbol: string): AssetIndexEntry | undefined {
  const normalizedSymbol = normalizeAssetSymbol(symbol);
  return registry.assets_index.find((asset) => asset.symbol === normalizedSymbol);
}

export function listCryptoRoutes(): readonly CryptoRoute[] {
  return registry.crypto_routes;
}

export const getCryptoRoutes = listCryptoRoutes;

export function getCryptoRoute(routeId: CryptoRouteId): CryptoRoute | undefined {
  const normalizedRouteId = normalizeRouteId(routeId);
  return registry.crypto_routes.find((route) => route.id === normalizedRouteId);
}

export function listCryptoRouteProviders(routeId: CryptoRouteId): readonly ResolvedProviderRef[] {
  const route = getCryptoRoute(routeId);
  return route ? resolveProviderRefs(route.providers) : [];
}

export function listCountries(filter: CountryFilter = {}): readonly Country[] {
  return registry.countries.filter((country) => {
    if (filter.currency !== undefined && country.currency !== filter.currency) return false;
    if (filter.coverage !== undefined && country.coverage !== filter.coverage) return false;
    return true;
  });
}

export const getCountries = listCountries;

export function getCountry(countryCode: CountryCode): Country | undefined {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  return registry.countries.find((country) => country.code === normalizedCountryCode);
}

export function listFiatRails(): readonly ResolvedFiatRail[] {
  return Object.entries(registry.fiat_rails).map(([id, rail]) => ({
    id,
    ...rail
  }));
}

export const getFiatRails = listFiatRails;

export function getFiatRail(railId: FiatRailId): FiatRail | undefined {
  return registry.fiat_rails[normalizeRailId(railId)];
}

export function listFiatRailCountries(railId: FiatRailId): readonly Country[] {
  const rail = getFiatRail(railId);
  if (!rail) return [];

  const countryCodes = new Set(Object.keys(rail.countries));
  return registry.countries.filter((country) => countryCodes.has(country.code));
}

export function getCountryRoutes(countryCode: CountryCode): readonly ResolvedCountryRoute[] {
  const country = getCountry(countryCode);
  if (!country) return [];

  return listFiatRails()
    .filter((rail) => rail.countries[country.code] !== undefined)
    .map((rail) => ({
      rail,
      country,
      providers: resolveProviderRefs(rail.countries[country.code] ?? [])
    }));
}

export function getPaymentWizardRoutes(options: PaymentWizardRouteRequest): readonly PaymentWizardRoute[] {
  if (options.asset !== undefined || options.route !== undefined) {
    const asset = options.asset === undefined ? undefined : getAsset(options.asset);
    const routeId = options.route === undefined ? asset?.route : normalizeRouteId(options.route);
    if (!routeId) return [];

    const route = getCryptoRoute(routeId);
    if (!route) return [];

    return [
      {
        kind: "crypto",
        route,
        providers: resolveProviderRefs(route.providers),
        ...(asset === undefined ? {} : { asset })
      }
    ];
  }

  if (options.country === undefined) return [];

  const countryRoutes = getCountryRoutes(options.country);
  if (options.rail === undefined) {
    return countryRoutes.map(toPaymentWizardFiatRoute);
  }

  const normalizedRail = normalizeRailId(options.rail);
  return countryRoutes
    .filter((route) => route.rail.id === normalizedRail)
    .map(toPaymentWizardFiatRoute);
}

export function listFiatProviders(options: {
  readonly rail: FiatRailId;
  readonly country: CountryCode;
}): readonly ResolvedProviderRef[] {
  const refs = getFiatRail(options.rail)?.countries[normalizeCountryCode(options.country)] ?? [];
  return resolveProviderRefs(refs);
}

export function listDisqualifiedProviders(): readonly DisqualifiedProvider[] {
  return registry.disqualified_providers;
}

export const getDisqualifiedProviders = listDisqualifiedProviders;

export function validateRegistry(input: ProviderRegistry = registry): ProviderRegistryValidationResult {
  const errors: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) errors.push(message);
  };

  const providers = input.providers ?? {};
  const cryptoRoutes = input.crypto_routes ?? [];
  const countries = input.countries ?? [];
  const fiatRails = input.fiat_rails ?? {};
  const disqualifiedProviders = input.disqualified_providers ?? [];
  const providerIds = new Set(Object.keys(providers));
  const disqualifiedIds = new Set(disqualifiedProviders.map((provider) => provider.id));
  const routeIds = new Set(cryptoRoutes.map((route) => route.id));
  const countryCodes = new Set(countries.map((country) => country.code));

  check(input.schema_version === "4.0.0", "provider registry schema version mismatch");
  check(typeof input.generated === "string" && input.generated.length > 0, "provider registry missing generated date");

  for (const duplicate of findDuplicates(cryptoRoutes.map((route) => route.id))) {
    check(false, `crypto route id ${duplicate} is duplicated`);
  }

  for (const duplicate of findDuplicates(countries.map((country) => country.code))) {
    check(false, `country code ${duplicate} is duplicated`);
  }

  for (const duplicate of findDuplicates(disqualifiedProviders.map((provider) => provider.id))) {
    check(false, `disqualified provider ${duplicate} is duplicated`);
  }

  for (const [id, provider] of Object.entries(providers)) {
    check(id === provider.id, `provider key/id mismatch for ${id}`);
    check(/^[a-z0-9-]+$/.test(id), `provider ${id} has invalid id`);
    check(Boolean(provider.name && provider.url), `provider ${id} missing name or url`);
    check(typeof provider.url === "string" && provider.url.startsWith("https://"), `provider ${id} url must be https`);
    check(typeof provider.icon_path === "string" && provider.icon_path.length > 0, `provider ${id} missing icon path`);
    check(!disqualifiedIds.has(id), `provider ${id} appears in disqualified providers`);

    check(provider.lightning_docs_url === null || typeof provider.lightning_docs_url === "string", `provider ${id} has invalid docs url`);
    if (provider.tutorials !== undefined) {
      check(Array.isArray(provider.tutorials), `provider ${id} tutorials must be an array`);
      let expectedIndex = 1;
      for (const tutorial of provider.tutorials ?? []) {
        check(tutorial.index === expectedIndex, `provider ${id} tutorials must be sequential`);
        check(typeof tutorial.path === "string" && tutorial.path.startsWith("assets/pay_tutorials/"), `provider ${id} tutorial ${tutorial.index} has invalid path`);
        check(typeof tutorial.caption === "string" && tutorial.caption.length > 0, `provider ${id} tutorial ${tutorial.index} missing caption`);
        expectedIndex += 1;
      }
    }
  }

  for (const asset of input.assets_index ?? []) {
    if (asset.route !== undefined) {
      check(routeIds.has(asset.route), `asset references missing route ${asset.route}`);
    }
  }

  for (const route of cryptoRoutes) {
    check(Boolean(route.id && route.symbol && route.label), `crypto route ${route.id} missing id/symbol/label`);
    check(Array.isArray(route.providers) && route.providers.length > 0, `crypto route ${route.id} needs providers`);

    let expectedRank = 1;
    const routeHasRanks = route.providers.some((ref) => ref.rank !== undefined);
    const routeProviderIds = new Set<ProviderId>();
    for (const ref of route.providers ?? []) {
      check(providerIds.has(ref.provider), `crypto route ${route.id} references missing provider ${ref.provider}`);
      check(!disqualifiedIds.has(ref.provider), `crypto route ${route.id} references disqualified provider ${ref.provider}`);
      check(!routeProviderIds.has(ref.provider), `crypto route ${route.id} references provider ${ref.provider} more than once`);
      routeProviderIds.add(ref.provider);
      if (routeHasRanks) {
        check(ref.rank === expectedRank, `crypto route ${route.id} ranks must be sequential`);
        expectedRank += 1;
      }
    }
  }

  for (const country of countries) {
    check(/^[A-Z]{2}$/.test(country.code), `country ${country.code} is not ISO alpha-2 shaped`);
    check(/^[A-Z]{3}$/.test(country.currency), `country ${country.code} currency is not ISO 4217 shaped`);
    check(
      country.coverage === "deep" || country.coverage === "thin" || country.coverage === "sparse",
      `country ${country.code} coverage invalid`
    );
  }

  for (const [railId, rail] of Object.entries(fiatRails)) {
    check(Boolean(rail.label), `fiat rail ${railId} missing label`);

    for (const [countryCode, refs] of Object.entries(rail.countries ?? {})) {
      check(/^[A-Z]{2}$/.test(countryCode), `fiat rail ${railId} has invalid country code ${countryCode}`);
      check(countryCodes.has(countryCode), `fiat rail ${railId} references unknown country ${countryCode}`);
      check(Array.isArray(refs) && refs.length > 0, `fiat rail ${railId}/${countryCode} needs providers`);

      let expectedRank = 1;
      const railProviderIds = new Set<ProviderId>();
      for (const ref of refs ?? []) {
        check(providerIds.has(ref.provider), `fiat rail ${railId}/${countryCode} references missing provider ${ref.provider}`);
        check(!disqualifiedIds.has(ref.provider), `fiat rail ${railId}/${countryCode} references disqualified provider ${ref.provider}`);
        check(!railProviderIds.has(ref.provider), `fiat rail ${railId}/${countryCode} references provider ${ref.provider} more than once`);
        railProviderIds.add(ref.provider);
        check(ref.rank === expectedRank, `fiat rail ${railId}/${countryCode} ranks must be sequential`);
        expectedRank += 1;
      }
    }
  }

  for (const provider of disqualifiedProviders) {
    check(!providerIds.has(provider.id), `disqualified provider ${provider.id} also appears as included`);
    check(Boolean(provider.reason), `disqualified provider ${provider.id} missing reason`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return [...duplicates];
}
