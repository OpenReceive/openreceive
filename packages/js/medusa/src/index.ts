// @openreceive/medusa: a Medusa plugin. Medusa loads its routes, its job, its
// migration script and its payment provider from .medusa/server/src; this
// entry holds only the names a storefront or a test needs, and imports
// nothing from Medusa.

/** The payment provider's identifier, the `openreceive` in `pp_openreceive_<id>`. */
export const OPENRECEIVE_MEDUSA_IDENTIFIER = "openreceive";

/** Where the plugin mounts the checkout's routes on the Medusa server. */
export const OPENRECEIVE_MEDUSA_ROUTE_PREFIX = "/store/openreceive";

/**
 * Medusa's id for the provider registered with `id` in medusa-config:
 * `pp_openreceive_openreceive` for the configuration the guide shows.
 */
export function openReceiveProviderId(id = OPENRECEIVE_MEDUSA_IDENTIFIER): string {
  return `pp_${OPENRECEIVE_MEDUSA_IDENTIFIER}_${id}`;
}

/** Whether a payment session or payment provider id belongs to this plugin. */
export function isOpenReceiveProvider(providerId: string | null | undefined): boolean {
  return (
    typeof providerId === "string" && providerId.startsWith(`pp_${OPENRECEIVE_MEDUSA_IDENTIFIER}_`)
  );
}
