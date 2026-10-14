import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Redirect,
  Render,
  Session,
} from "@nestjs/common";
import { ProductsService } from "../products/products.service.js";
import { OrdersService } from "./orders.service.js";

interface ShopSession {
  visitorId?: string;
  save(callback: (error?: unknown) => void): void;
}

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly products: ProductsService,
  ) {}

  @Post()
  @Redirect()
  async place(@Body("product_id") productId: string, @Session() session: ShopSession) {
    const product = await this.products.find(Number(productId));
    if (product === null) throw new NotFoundException("That product is not in the catalog.");
    session.visitorId ??= randomUUID();
    const order = await this.orders.place(session.visitorId, product);
    // Store the session before the redirect goes out: express-session writes
    // it as the response ends, and the browser can ask for the order page
    // before a Postgres store has it, which answers that page with a 404.
    await new Promise<void>((resolve, reject) =>
      session.save((error) => (error ? reject(error) : resolve())),
    );
    return { url: `/orders/${order.id}`, statusCode: 303 };
  }

  @Get(":id")
  @Render("order")
  async show(@Param("id", ParseIntPipe) id: number, @Session() session: ShopSession) {
    const order = await this.orders.findOwn(id, session.visitorId);
    if (order === null) throw new NotFoundException("That order is not yours.");
    return { order, paid: order.status === "paid" };
  }
}
