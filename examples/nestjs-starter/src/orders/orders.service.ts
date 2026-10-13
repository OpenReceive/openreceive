import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { product } from "../catalog.js";
import { Order } from "./order.entity.js";

// A reference arrives from the payer's browser. Anything but a uuid is no
// order of ours, and Postgres would refuse it in a uuid comparison.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OrdersService {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  /** Creates the order before checkout. Its id is the OpenReceive reference. */
  place(visitorId: string): Promise<Order> {
    return this.orders.save(
      this.orders.create({
        visitorId,
        productName: product.name,
        amount: product.price,
        currency: product.currency,
      }),
    );
  }

  async find(id: string): Promise<Order | null> {
    return UUID.test(id) ? this.orders.findOneBy({ id }) : null;
  }

  /** The order, only when this visitor placed it. */
  async findOwn(id: string, visitorId: string | undefined): Promise<Order | null> {
    if (visitorId === undefined || !UUID.test(id)) return null;
    return this.orders.findOneBy({ id, visitorId });
  }
}
