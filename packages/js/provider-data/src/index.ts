import providerRegistryJson from "./data/openreceive-providers.v4.json" with { type: "json" };
import { payTutorialUrls } from "./pay-tutorials.ts";
import { providerIconUrls } from "./provider-icons.ts";

export { payTutorialUrls };
export { providerIconUrls };
// The packaged asset URLs above only resolve under Vite/Rollup. `AssetUrlResolver`
// is the seam for every other host, and `warnOnFileAssetUrl` is the diagnostic
// that says out loud when the packaged resolution has failed.
export {
  type AssetUrlResolver,
  createAssetBaseUrlResolver,
  lazyAssetUrlTable,
  warnOnFileAssetUrl,
} from "./asset-url.ts";

export type ProviderId = string;
export type CryptoRouteId = string;

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly kind: string;
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
  readonly disqualified_providers: readonly DisqualifiedProvider[];
}

export interface ResolvedProviderRef {
  readonly provider: Provider;
  readonly rank?: number;
}

export interface ProviderFilter {
  readonly us?: boolean | null;
}

export interface PaymentWizardRouteRequest {
  readonly asset?: string;
  readonly route?: CryptoRouteId;
}

export interface PaymentWizardRoute {
  readonly kind: "crypto";
  readonly route: CryptoRoute;
  readonly providers: readonly ResolvedProviderRef[];
  readonly asset?: AssetIndexEntry;
}

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

/**
 * The one route a checkout renders provider suggestions for. See
 * {@link getPaymentWizardRoutes}.
 */
export const DEFAULT_PAYMENT_WIZARD_ROUTE: CryptoRouteId = "btc-lightning";

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
    ...(ref.rank === undefined ? {} : { rank: ref.rank }),
  };
}

function resolveProviderRefs(refs: readonly ProviderRef[]): readonly ResolvedProviderRef[] {
  return refs.map(resolveProviderRef);
}

function normalizeAssetSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

function normalizeRouteId(routeId: CryptoRouteId): CryptoRouteId {
  return routeId.trim().toLowerCase();
}

export const providerRegistry: ProviderRegistry = registry;

export function getProviderRegistryMetadata() {
  return {
    schema_version: registry.schema_version,
    generated: registry.generated,
    description: registry.description,
    filter: registry.filter,
  };
}

export function listProviders(filter: ProviderFilter = {}): readonly Provider[] {
  return Object.values(registry.providers)
    .filter((provider) => filter.us === undefined || provider.us === filter.us)
    .sort(sortByProviderName);
}

export function getProvider(providerId: ProviderId): Provider | undefined {
  return registry.providers[providerId];
}

export function providerIconUrl(provider: Pick<Provider, "icon_path">): string {
  return providerIconUrls[provider.icon_path] ?? provider.icon_path;
}

export function providerTutorialUrl(tutorial: Pick<ProviderTutorial, "path">): string {
  return payTutorialUrls[tutorial.path] ?? tutorial.path;
}

export function listAssets(): readonly AssetIndexEntry[] {
  return registry.assets_index;
}

export function getAsset(symbol: string): AssetIndexEntry | undefined {
  const normalizedSymbol = normalizeAssetSymbol(symbol);
  return registry.assets_index.find((asset) => asset.symbol === normalizedSymbol);
}

function getCryptoRoute(routeId: CryptoRouteId): CryptoRoute | undefined {
  const normalizedRouteId = normalizeRouteId(routeId);
  return registry.crypto_routes.find((route) => route.id === normalizedRouteId);
}

export function listCryptoRouteProviders(routeId: CryptoRouteId): readonly ResolvedProviderRef[] {
  const route = getCryptoRoute(routeId);
  return route ? resolveProviderRefs(route.providers) : [];
}

/**
 * The provider rows for one route. Called with nothing, it answers the question
 * a checkout is actually asking: `btc-lightning` is the only route that belongs
 * under a Lightning invoice, and the other routes list exchanges that convert an
 * asset INTO a Lightning payment — a different path from the deposit address a
 * swap provider already quoted, and a mid-payment misdirection on a deposit
 * panel. So the minimal call is the correct one, and naming another route is a
 * deliberate act.
 *
 * The default is gated on "neither input supplied", never on an unresolvable
 * route: the registry ships fiat assets with no route at all (`usd`, `eur`,
 * `gbp`), and `{ asset: "usd" }` must keep returning [] rather than silently
 * answering with Lightning.
 */
export function getPaymentWizardRoutes(
  options: PaymentWizardRouteRequest = {},
): readonly PaymentWizardRoute[] {
  const asset = options.asset === undefined ? undefined : getAsset(options.asset);
  const routeId =
    options.asset === undefined && options.route === undefined
      ? DEFAULT_PAYMENT_WIZARD_ROUTE
      : options.route === undefined
        ? asset?.route
        : normalizeRouteId(options.route);
  if (!routeId) return [];

  const route = getCryptoRoute(routeId);
  if (!route) return [];

  return [
    {
      kind: "crypto",
      route,
      providers: resolveProviderRefs(route.providers),
      ...(asset === undefined ? {} : { asset }),
    },
  ];
}

export function validateRegistry(
  input: ProviderRegistry = registry,
): ProviderRegistryValidationResult {
  const errors: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) errors.push(message);
  };

  const providers = input.providers === undefined ? {} : input.providers;
  const cryptoRoutes = input.crypto_routes ?? [];
  const disqualifiedProviders = input.disqualified_providers ?? [];
  const providerIds = new Set(Object.keys(providers));
  const disqualifiedIds = new Set(disqualifiedProviders.map((provider) => provider.id));
  const routeIds = new Set(cryptoRoutes.map((route) => route.id));

  check(input.schema_version === "4.0.0", "provider registry schema version mismatch");
  check(
    typeof input.generated === "string" && input.generated.length > 0,
    "provider registry missing generated date",
  );

  for (const duplicate of findDuplicates(cryptoRoutes.map((route) => route.id))) {
    check(false, `crypto route id ${duplicate} is duplicated`);
  }

  for (const duplicate of findDuplicates(disqualifiedProviders.map((provider) => provider.id))) {
    check(false, `disqualified provider ${duplicate} is duplicated`);
  }

  for (const [id, provider] of Object.entries(providers)) {
    check(id === provider.id, `provider key/id mismatch for ${id}`);
    check(/^[a-z0-9-]+$/.test(id), `provider ${id} has invalid id`);
    check(Boolean(provider.name && provider.url), `provider ${id} missing name or url`);
    check(
      typeof provider.kind === "string" && provider.kind.length > 0,
      `provider ${id} missing kind`,
    );
    check(
      typeof provider.url === "string" && provider.url.startsWith("https://"),
      `provider ${id} url must be https`,
    );
    check(
      typeof provider.icon_path === "string" && provider.icon_path.length > 0,
      `provider ${id} missing icon path`,
    );
    check(!disqualifiedIds.has(id), `provider ${id} appears in disqualified providers`);

    check(
      provider.lightning_docs_url === null || typeof provider.lightning_docs_url === "string",
      `provider ${id} has invalid docs url`,
    );
    if (provider.tutorials !== undefined) {
      check(Array.isArray(provider.tutorials), `provider ${id} tutorials must be an array`);
      let expectedIndex = 1;
      for (const tutorial of provider.tutorials ?? []) {
        check(tutorial.index === expectedIndex, `provider ${id} tutorials must be sequential`);
        check(
          typeof tutorial.path === "string" && tutorial.path.startsWith("assets/pay_tutorials/"),
          `provider ${id} tutorial ${tutorial.index} has invalid path`,
        );
        check(
          typeof tutorial.caption === "string" && tutorial.caption.length > 0,
          `provider ${id} tutorial ${tutorial.index} missing caption`,
        );
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
    check(
      Boolean(route.id && route.symbol && route.label),
      `crypto route ${route.id} missing id/symbol/label`,
    );
    check(
      Array.isArray(route.providers) && route.providers.length > 0,
      `crypto route ${route.id} needs providers`,
    );

    // Rank rule: ranks are optional per route, but once any provider in a
    // route carries a rank, every provider in that route must be ranked and
    // the ranks must run 1..n in listed order.
    let expectedRank = 1;
    const routeHasRanks = route.providers.some((ref) => ref.rank !== undefined);
    const routeProviderIds = new Set<ProviderId>();
    for (const ref of route.providers) {
      check(
        providerIds.has(ref.provider),
        `crypto route ${route.id} references missing provider ${ref.provider}`,
      );
      check(
        !disqualifiedIds.has(ref.provider),
        `crypto route ${route.id} references disqualified provider ${ref.provider}`,
      );
      check(
        !routeProviderIds.has(ref.provider),
        `crypto route ${route.id} references provider ${ref.provider} more than once`,
      );
      routeProviderIds.add(ref.provider);
      if (routeHasRanks) {
        check(ref.rank === expectedRank, `crypto route ${route.id} ranks must be sequential`);
        expectedRank += 1;
      }
    }
  }

  for (const provider of disqualifiedProviders) {
    check(
      !providerIds.has(provider.id),
      `disqualified provider ${provider.id} also appears as included`,
    );
    check(Boolean(provider.reason), `disqualified provider ${provider.id} missing reason`);
  }

  return {
    valid: errors.length === 0,
    errors,
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
