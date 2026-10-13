import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import type { Product } from "../products/product.entity.js";
import { Order } from "./order.entity.js";

@Injectable()
export class OrdersService {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  /** Copies the product's current price into a new order. */
  place(visitorId: string, product: Product): Promise<Order> {
    return this.orders.save(
      this.orders.create({
        visitorId,
        productName: product.name,
        amount: product.price,
        currency: "USD",
        status: "awaiting_payment",
      }),
    );
  }

  find(id: number): Promise<Order | null> {
    return this.orders.findOneBy({ id });
  }

  /** The order, only when this visitor placed it. */
  async findOwn(id: number, visitorId: string | undefined): Promise<Order | null> {
    if (visitorId === undefined) return null;
    return this.orders.findOneBy({ id, visitorId });
  }
}
