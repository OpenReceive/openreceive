import path from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Sessions live in Postgres, beside the orders. A visitor gets one when
  // they place their first order.
  const PgStore = connectPgSimple(session);
  app.use(
    session({
      store: new PgStore({
        conString: process.env.DATABASE_URL,
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET ?? "",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 },
    }),
  );

  app.setBaseViewsDir(path.join(import.meta.dirname, "..", "views"));
  app.setViewEngine("hbs");

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}
await bootstrap();
