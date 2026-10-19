// A Vendure 3 server with the OpenReceive plugin, for tests/vendure. The
// test starts it as its own process, so Node trusts the test relay's CA from
// NODE_EXTRA_CA_CERTS. It runs its migrations (the plugin's included), seeds
// a channel with free shipping, no tax and two products on its first start,
// and runs the plugin's scheduled task itself rather than in a worker.
import path from "node:path";
import { OpenReceivePlugin } from "@openreceive/vendure/plugin";
import {
  bootstrap,
  DefaultJobQueuePlugin,
  DefaultSchedulerPlugin,
  dummyPaymentHandler,
  LanguageCode,
  Product,
  runMigrations,
  TransactionalConnection,
} from "@vendure/core";
import { populate } from "@vendure/core/cli/index.js";

const database = new URL(process.env.OPENRECEIVE_TEST_VENDURE_POSTGRES_URL);

const config = {
  apiOptions: {
    port: Number(process.env.PORT),
    adminApiPath: "admin-api",
    shopApiPath: "shop-api",
  },
  authOptions: {
    tokenMethod: ["bearer", "cookie"],
    superadminCredentials: { identifier: "superadmin", password: "superadmin-test" },
    cookieOptions: { secret: "openreceive-vendure-test" },
  },
  dbConnectionOptions: {
    type: "postgres",
    synchronize: true,
    migrations: [],
    logging: false,
    host: database.hostname,
    port: Number(database.port || 5432),
    username: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password),
    database: database.pathname.slice(1),
  },
  paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
  schedulerOptions: { runTasksInWorkerOnly: false },
  plugins: [
    DefaultSchedulerPlugin.init(),
    DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
    OpenReceivePlugin,
  ],
};

await runMigrations(config);
const app = await bootstrap(config);
if ((await app.get(TransactionalConnection).rawConnection.getRepository(Product).count()) === 0) {
  await populate(
    async () => app,
    {
      defaultLanguage: LanguageCode.en,
      defaultZone: "Americas",
      taxRates: [{ name: "Standard Tax", percentage: 0 }],
      shippingMethods: [{ name: "Free shipping", price: 0 }],
      paymentMethods: [],
      collections: [],
      countries: [{ name: "United States", code: "US", zone: "Americas" }],
    },
    path.join(import.meta.dirname, "products.csv"),
  );
}
console.log("vendure test server ready");
