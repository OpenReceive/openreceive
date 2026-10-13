import { Controller, Get, Render } from "@nestjs/common";
import { ProductsService } from "./products.service.js";

@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Render("index")
  async index() {
    return { products: await this.products.list() };
  }
}
