import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("orders")
export class Order {
  /** The payment reference: created before checkout, never reused. */
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** The session's visitor id. Only that browser may see or pay the order. */
  @Column({ name: "visitor_id" })
  visitorId: string;

  @Column({ name: "product_name" })
  productName: string;

  /** A decimal string, copied from the catalog when the order is placed. */
  @Column({ type: "numeric", precision: 10, scale: 2 })
  amount: string;

  @Column()
  currency: string;

  /** "awaiting_payment" until onPaid marks it "paid". */
  @Column({ type: "text", default: "awaiting_payment" })
  status: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
