import { randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
  Render,
  Session,
} from "@nestjs/common";
import { product } from "../catalog.js";
import { OrdersService } from "./orders.service.js";

/** What the shop keeps in express-session. */
export interface ShopSession {
  visitorId?: string;
}

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Render("home")
  home() {
    return { product };
  }

  @Post("orders")
  @Redirect()
  async place(@Session() session: ShopSession) {
    session.visitorId ??= randomUUID();
    const order = await this.orders.place(session.visitorId);
    return { url: `/orders/${order.id}`, statusCode: 303 };
  }

  // The order's own URL. A payer can reload or bookmark it to come back to a
  // pending payment or a swap refund.
  @Get("orders/:id")
  @Render("order")
  async show(@Param("id", ParseUUIDPipe) id: string, @Session() session: ShopSession) {
    const order = await this.orders.findOwn(id, session.visitorId);
    if (order === null) throw new NotFoundException("Order not found");
    return { order, paid: order.status === "paid" };
  }
}
