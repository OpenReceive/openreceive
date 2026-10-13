import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateShop1760000000000 implements MigrationInterface {
  name = "CreateShop1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  sku TEXT NOT NULL UNIQUE
)`);
    await queryRunner.query(`CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
    await queryRunner.query(`INSERT INTO products (name, price, sku) VALUES
  ('Facet', 7.00, 'facet'),
  ('Bezel', 12.00, 'bezel'),
  ('Hinge', 4.00, 'hinge'),
  ('Latch', 9.00, 'latch'),
  ('Knob', 3.00, 'knob')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE orders");
    await queryRunner.query("DROP TABLE products");
  }
}
