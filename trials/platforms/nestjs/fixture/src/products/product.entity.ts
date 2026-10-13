import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("products")
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  /** A decimal string, e.g. "7.00". */
  @Column({ type: "numeric", precision: 10, scale: 2 })
  price: string;

  @Column({ unique: true })
  sku: string;
}
