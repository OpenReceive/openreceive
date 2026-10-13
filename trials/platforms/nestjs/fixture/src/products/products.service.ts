import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { Product } from "./product.entity.js";

@Injectable()
export class ProductsService {
  constructor(@InjectRepository(Product) private readonly products: Repository<Product>) {}

  list(): Promise<Product[]> {
    return this.products.find({ order: { id: "ASC" } });
  }

  find(id: number): Promise<Product | null> {
    return this.products.findOneBy({ id });
  }
}
