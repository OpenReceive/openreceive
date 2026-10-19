import { ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";

// Widget Shop's store: one US region in dollars, free shipping, the
// storefront's publishable key and five products. A store it already
// filled is left as it is.

// The storefront is built with this key (compose.yml).
const PUBLISHABLE_KEY =
  "pk_0e9eeb38c05b76885bb8b6cfc93b6f95f7e7d7311364198ae780ae12add65e85";

const CATALOG = [
  { title: "Facet", handle: "facet", price: 7 },
  { title: "Bezel", handle: "bezel", price: 12 },
  { title: "Hinge", handle: "hinge", price: 4 },
  { title: "Latch", handle: "latch", price: 9 },
  { title: "Knob", handle: "knob", price: 3 },
];

export default async function seedWidgetShop({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const productModuleService = container.resolve(Modules.PRODUCT);
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT);
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL);
  const storeModuleService = container.resolve(Modules.STORE);

  if ((await productModuleService.listProducts({ handle: "facet" })).length > 0) {
    logger.info("Widget Shop is already seeded.");
    return;
  }

  logger.info("Seeding Widget Shop...");
  const [store] = await storeModuleService.listStores();
  let salesChannels = await salesChannelModuleService.listSalesChannels({
    name: "Default Sales Channel",
  });
  if (!salesChannels.length) {
    const { result } = await createSalesChannelsWorkflow(container).run({
      input: { salesChannelsData: [{ name: "Default Sales Channel" }] },
    });
    salesChannels = result;
  }
  const salesChannel = salesChannels[0];

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        name: "Widget Shop",
        supported_currencies: [{ currency_code: "usd", is_default: true }],
        default_sales_channel_id: salesChannel.id,
      },
    },
  });

  const { result: regions } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "United States",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        },
      ],
    },
  });
  await createTaxRegionsWorkflow(container).run({
    input: [{ country_code: "us", provider_id: "tp_system" }],
  });

  const { result: locations } = await createStockLocationsWorkflow(container).run({
    input: {
      locations: [
        {
          name: "Widget Warehouse",
          address: { city: "Portland", country_code: "US", address_1: "" },
        },
      ],
    },
  });
  const location = locations[0];
  await updateStoresWorkflow(container).run({
    input: { selector: { id: store.id }, update: { default_location_id: location.id } },
  });
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  });

  const profiles = await fulfillmentModuleService.listShippingProfiles({ type: "default" });
  let profile = profiles.length ? profiles[0] : null;
  if (!profile) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default Shipping Profile", type: "default" }] },
    });
    profile = result[0];
  }
  const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
    name: "Widget Warehouse delivery",
    type: "shipping",
    service_zones: [
      { name: "United States", geo_zones: [{ country_code: "us", type: "country" }] },
    ],
  });
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  });
  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Free Shipping",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: profile.id,
        type: { label: "Free", description: "Ships in 2-3 days.", code: "free" },
        prices: [
          { currency_code: "usd", amount: 0 },
          { region_id: regions[0].id, amount: 0 },
        ],
        rules: [
          { attribute: "enabled_in_store", value: "true", operator: "eq" },
          { attribute: "is_return", value: "false", operator: "eq" },
        ],
      },
    ],
  });
  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: location.id, add: [salesChannel.id] },
  });

  const {
    result: [apiKey],
  } = await createApiKeysWorkflow(container).run({
    input: { api_keys: [{ title: "Widget Shop storefront", type: "publishable", created_by: "" }] },
  });
  await pg.raw("UPDATE api_key SET token = ?, redacted = ? WHERE id = ?", [
    PUBLISHABLE_KEY,
    `${PUBLISHABLE_KEY.slice(0, 6)}***${PUBLISHABLE_KEY.slice(-3)}`,
    apiKey.id,
  ]);
  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: apiKey.id, add: [salesChannel.id] },
  });

  await createProductsWorkflow(container).run({
    input: {
      products: CATALOG.map(({ title, handle, price }) => ({
        title,
        handle,
        description: `The ${title}, from Widget Shop.`,
        status: ProductStatus.PUBLISHED,
        shipping_profile_id: profile!.id,
        options: [{ title: "Finish", values: ["Standard"] }],
        variants: [
          {
            title: "Standard",
            sku: handle.toUpperCase(),
            manage_inventory: false,
            options: { Finish: "Standard" },
            prices: [{ amount: price, currency_code: "usd" }],
          },
        ],
        sales_channels: [{ id: salesChannel.id }],
      })),
    },
  });
  logger.info("Seeded Widget Shop: one region, five products.");
}
