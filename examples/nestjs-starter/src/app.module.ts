import path from "node:path";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HealthController } from "./health.controller.js";
import { Order } from "./orders/order.entity.js";
import { OrdersModule } from "./orders/orders.module.js";

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      url: process.env.DATABASE_URL,
      entities: [Order],
      // Runs src/migrations at start: the orders table, then OpenReceive's
      // two tables from `npx openreceive scaffold payments --orm typeorm`.
      migrations: [path.join(import.meta.dirname, "migrations", "*.js")],
      migrationsRun: true,
      synchronize: false,
    }),
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
