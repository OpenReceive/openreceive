import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

export type OrderStatus = "awaiting_payment" | "paid";

@Entity("orders")
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  /** The session's visitor id: only that browser may see the order. */
  @Column({ name: "visitor_id" })
  visitorId: string;

  @Column({ name: "product_name" })
  productName: string;

  /** A decimal string, copied from the product when the order is placed. */
  @Column({ type: "numeric", precision: 10, scale: 2 })
  amount: string;

  @Column()
  currency: string;

  @Column({ type: "text", default: "awaiting_payment" })
  status: OrderStatus;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
