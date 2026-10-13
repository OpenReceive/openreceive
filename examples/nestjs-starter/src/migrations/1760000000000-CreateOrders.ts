import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOrders1760000000000 implements MigrationInterface {
  name = "CreateOrders1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  paid_at BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE orders");
  }
}
