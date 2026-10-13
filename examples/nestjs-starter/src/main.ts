import path from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { openReceiveExpress } from "@openreceive/express";
import { typeOrmDb } from "@openreceive/http";
import connectPgSimple from "connect-pg-simple";
import type { Request } from "express";
import session from "express-session";
import { DataSource } from "typeorm";
import { AppModule } from "./app.module.js";
import type { ShopSession } from "./orders/orders.controller.js";
import { OrdersService } from "./orders/orders.service.js";

const app = await NestFactory.create<NestExpressApplication>(AppModule);

// Sessions live in Postgres, beside the orders. A visitor gets one when they
// place their first order.
const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({ conString: process.env.DATABASE_URL, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET ?? "",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 },
  }),
);

// The payment routes, under /openreceive. This is Express middleware, so
// Nest's guards and pipes do not run here: `authorize` makes the order
// page's own ownership check. Settlement runs during requests to these
// routes: no worker, cron job or timer is needed.
const orders = app.get(OrdersService);
// Nest adds its own JSON body parser only when the app starts listening,
// after this mount. The checkout's requests need it before.
app.useBodyParser("json");
// Behind a proxy, the rate limiter needs each payer's IP.
app.set("trust proxy", 1);
app.use(
  openReceiveExpress({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db: typeOrmDb(app.get(DataSource), "postgres"),
      // Runs once, inside the settlement transaction. `$1` placeholders.
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE orders SET status = 'paid', paid_at = $1 WHERE id = $2 AND status = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await orders.find(reference);
      return order && order.status === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.productName }
        : null;
    },
    // Only the browser that placed the order may pay for it.
    authorize: async ({ native, resource }) => {
      const { visitorId } = (native as Request).session as ShopSession;
      return (await orders.findOwn(resource.reference ?? "", visitorId)) !== null;
    },
    rateLimiting: true,
  }),
);

// The drop-in checkout as one ES module and one stylesheet, served straight
// from the installed package: no frontend build.
app.useStaticAssets(
  path.dirname(
    fileURLToPath(import.meta.resolve("@openreceive/elements/standalone/openreceive-checkout.js")),
  ),
  { prefix: "/checkout-assets/" },
);
app.setBaseViewsDir(path.join(import.meta.dirname, "..", "views"));
app.setViewEngine("hbs");

await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
