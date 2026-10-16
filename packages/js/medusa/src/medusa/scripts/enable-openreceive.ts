import { OPENRECEIVE_MEDUSA_IDENTIFIER, openReceiveProviderId } from "../../index.ts";

// `npx medusa exec ./node_modules/@openreceive/medusa/dist/enable-openreceive.js`
// offers OpenReceive in every region, as ticking it under each region's
// payment providers in the admin does. Safe to run again. An argument names
// the provider's id from medusa-config when it is not "openreceive".

interface Container {
  resolve<T = unknown>(key: string): T;
}

interface Query {
  graph(input: {
    readonly entity: string;
    readonly fields: readonly string[];
    readonly filters?: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly data: readonly Record<string, unknown>[] }>;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

type UpdateRegions = typeof import("@medusajs/medusa/core-flows").updateRegionsWorkflow;

export default async function enableOpenReceive({
  container,
  args = [],
}: {
  readonly container: Container;
  readonly args?: readonly string[];
}): Promise<void> {
  const providerId = openReceiveProviderId(args[0] ?? OPENRECEIVE_MEDUSA_IDENTIFIER);
  const query = container.resolve<Query>("query");
  const logger = container.resolve<Logger>("logger");
  const { data: providers } = await query.graph({
    entity: "payment_provider",
    fields: ["id"],
    filters: { id: providerId },
  });
  if (providers.length === 0) {
    throw new Error(
      `Medusa has no payment provider ${providerId}. Add @openreceive/medusa/providers/openreceive with id "${args[0] ?? OPENRECEIVE_MEDUSA_IDENTIFIER}" to the payment module's providers in medusa-config, restart Medusa, and run this again.`,
    );
  }
  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "payment_providers.id"],
  });
  if (regions.length === 0) {
    logger.warn("OpenReceive: this store has no regions yet. Create one, then run this again.");
    return;
  }
  const flows = (await import("@medusajs/medusa/core-flows")) as {
    updateRegionsWorkflow?: UpdateRegions;
    default?: { updateRegionsWorkflow?: UpdateRegions };
  };
  const updateRegions = flows.updateRegionsWorkflow ?? flows.default?.updateRegionsWorkflow;
  if (updateRegions === undefined) throw new Error("Medusa has no updateRegionsWorkflow.");
  for (const region of regions) {
    const current = ((region.payment_providers ?? []) as { id?: unknown }[])
      .map((provider) => provider.id)
      .filter((id): id is string => typeof id === "string");
    if (current.includes(providerId)) {
      logger.info(`OpenReceive: region ${String(region.name)} already offers ${providerId}.`);
      continue;
    }
    await updateRegions(container).run({
      input: {
        selector: { id: region.id },
        update: { payment_providers: [...current, providerId] },
      },
    });
    logger.info(`OpenReceive: region ${String(region.name)} now offers ${providerId}.`);
  }
}
