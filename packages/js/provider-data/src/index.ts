import providerRegistryJson from "../../../../spec/data/providers/openreceive-providers.v2.json" with { type: "json" };

export type ProviderMechanism = "pay_invoice" | "withdraw_to_invoice";
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
  readonly pays_arbitrary_invoice: true;
  readonly mechanism: ProviderMechanism;
  readonly lightning_docs_url: string | null;
  readonly blurb: string;
  readonly caveat?: string;
}

export interface ProviderRef {
  readonly provider: ProviderId;
  readonly flagship?: boolean;
  readonly blurb_override?: string;
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
  readonly summary: string;
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

export interface DisqualifiedProvider {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly reason: string;
}

export interface ProviderRegistry {
  readonly schema_version: "2.0.0";
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
  readonly blurb: string;
  readonly rank?: number;
}

export interface ProviderFilter {
  readonly mechanism?: ProviderMechanism;
  readonly us?: boolean | null;
}

export interface CountryFilter {
  readonly currency?: string;
  readonly coverage?: CountryCoverage;
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
    blurb: ref.blurb_override ?? provider.blurb,
    ...(ref.rank === undefined ? {} : { rank: ref.rank })
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
    .filter((provider) => filter.mechanism === undefined || provider.mechanism === filter.mechanism)
    .filter((provider) => filter.us === undefined || provider.us === filter.us)
    .sort(sortByProviderName);
}

export function getProvider(providerId: ProviderId): Provider | undefined {
  return registry.providers[providerId];
}

export function listAssets(): readonly AssetIndexEntry[] {
  return registry.assets_index;
}

export function getAsset(symbol: string): AssetIndexEntry | undefined {
  return registry.assets_index.find((asset) => asset.symbol === symbol);
}

export function listCryptoRoutes(): readonly CryptoRoute[] {
  return registry.crypto_routes;
}

export function getCryptoRoute(routeId: CryptoRouteId): CryptoRoute | undefined {
  return registry.crypto_routes.find((route) => route.id === routeId);
}

export function listCryptoRouteProviders(routeId: CryptoRouteId): readonly ResolvedProviderRef[] {
  return getCryptoRoute(routeId)?.providers.map(resolveProviderRef) ?? [];
}

export function listCountries(filter: CountryFilter = {}): readonly Country[] {
  return registry.countries.filter((country) => {
    if (filter.currency !== undefined && country.currency !== filter.currency) return false;
    if (filter.coverage !== undefined && country.coverage !== filter.coverage) return false;
    return true;
  });
}

export function getCountry(countryCode: CountryCode): Country | undefined {
  return registry.countries.find((country) => country.code === countryCode);
}

export function listFiatRails(): ReadonlyArray<FiatRail & { readonly id: FiatRailId }> {
  return Object.entries(registry.fiat_rails).map(([id, rail]) => ({
    id,
    ...rail
  }));
}

export function getFiatRail(railId: FiatRailId): FiatRail | undefined {
  return registry.fiat_rails[railId];
}

export function listFiatRailCountries(railId: FiatRailId): readonly Country[] {
  const rail = getFiatRail(railId);
  if (!rail) return [];

  const countryCodes = new Set(Object.keys(rail.countries));
  return registry.countries.filter((country) => countryCodes.has(country.code));
}

export function listFiatProviders(options: {
  readonly rail: FiatRailId;
  readonly country: CountryCode;
}): readonly ResolvedProviderRef[] {
  const refs = getFiatRail(options.rail)?.countries[options.country] ?? [];
  return refs.map(resolveProviderRef);
}

export function listDisqualifiedProviders(): readonly DisqualifiedProvider[] {
  return registry.disqualified_providers;
}
