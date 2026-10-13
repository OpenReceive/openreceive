import path from "node:path";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HealthController } from "./health.controller.js";
import { Order } from "./orders/order.entity.js";
import { OrdersModule } from "./orders/orders.module.js";
import { Product } from "./products/product.entity.js";
import { ProductsModule } from "./products/products.module.js";

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      url: process.env.DATABASE_URL,
      entities: [Product, Order],
      // Pending migrations in src/migrations run when the app starts.
      migrations: [path.join(import.meta.dirname, "migrations", "*.js")],
      migrationsRun: true,
      synchronize: false,
    }),
    ProductsModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
