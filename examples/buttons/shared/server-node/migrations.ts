/**
 * The shop's schema, as a numbered list applied in order at boot.
 *
 * ONE list, three stacks. node-express, nextjs-fullstack and
 * static-html-small-api all boot the same store and therefore the same
 * migrations; nothing that names a column is written twice.
 *
 * WHY A MODULE AND NOT A DIRECTORY OF .sql FILES. Numbered files read from
 * disk are the nicer shape and they are what this demo wanted, but two of the
 * five steps are not static SQL — 004 renders the engine's own DDL and 005
 * reads the catalog — and the three stacks bundle server code three different
 * ways. A runtime `readdir` of a migrations directory survives `tsx` and
 * breaks the day a Next.js build does not copy it. An explicit array is the
 * same mechanism with the same numbers, visible at once, and it cannot be
 * half-shipped by a bundler.
 *
 * SQLite type notes, because this schema is Postgres' twin and the
 * differences are where the bugs live:
 *   uuid       TEXT, generated in application code (`crypto.randomUUID()`).
 *   boolean    INTEGER 0/1, with an explicit CHECK.
 *   timestamp  INTEGER unix SECONDS — not a string, not milliseconds. The wire
 *              format is unix seconds and one conversion beats three.
 *   money      INTEGER cents, exactly as on Rails.
 * Foreign keys need `PRAGMA foreign_keys = ON` per connection (store.ts does
 * it); it is off by default and a missing FK is silent.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { paymentsSchemaSql } from "@openreceive/http";

export interface ShopCatalogSeedEntry {
  readonly sku: string;
  readonly name: string;
  readonly price_cents: number;
  readonly position: number;
  readonly image_name?: string;
}

export interface ShopMigration {
  readonly id: string;
  readonly run: (db: DatabaseSync) => void;
}

const SHARED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The six buttons, from examples/buttons/shared/shop-catalog.json — the ONE
 * file every stack's data migration reads. Read from disk rather than imported
 * so the three bundlers behave the same.
 */
export const catalogSeedEntries = (): readonly ShopCatalogSeedEntry[] =>
  JSON.parse(
    readFileSync(path.join(SHARED_ROOT, "shop-catalog.json"), "utf8"),
  ) as readonly ShopCatalogSeedEntry[];

/**
 * The convention as a DEFAULT, not as a derivation — the same rule
 * ShopProduct#default_image_name applies on Rails. Leave `image_name` out of a
 * seed row and this fills it in; set it and it is respected, which is what
 * lets a later higher-resolution download be added without renaming anything.
 */
export const defaultImageName = (sku: string): string => `openreceive-${sku}-button.webp`;

export const migrations: readonly ShopMigration[] = [
  {
    // The price authority, as a table. Created once, correct: there is no
    // transition sequence here and no backfill, because a reference app that
    // ships its author's migration scaffolding teaches the wrong lesson.
    id: "001_create_shop_products",
    run: (db) =>
      db.exec(`
        CREATE TABLE shop_products (
          id          TEXT    PRIMARY KEY NOT NULL,
          sku         TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          price_cents INTEGER NOT NULL CHECK (price_cents > 0),
          position    INTEGER NOT NULL DEFAULT 0,
          -- A FILENAME, not bytes and not an attachment: examples/buttons/images
          -- holds the one copy and four stacks read it. A column rather than a
          -- derivation from the sku, so a product can never end up with a
          -- download that differs from its thumbnail.
          image_name  TEXT    NOT NULL,
          active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX index_shop_products_on_sku ON shop_products (sku);
        CREATE INDEX index_shop_products_on_active_and_position
          ON shop_products (active, position);
      `),
  },
  {
    // A visitor: two uuids and two timestamps. No email, no name, no password,
    // no IP, no OAuth — a user with no credentials is the feature.
    //
    // `id` is the ownership token that lives in the signed cookie and is never
    // rendered. `public_ref` is the handle the recent-orders feed shows.
    id: "002_create_shop_users",
    run: (db) =>
      db.exec(`
        CREATE TABLE shop_users (
          id            TEXT    PRIMARY KEY NOT NULL,
          public_ref    TEXT    NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX index_shop_users_on_public_ref ON shop_users (public_ref);
      `),
  },
  {
    // The order and its items, in one migration because neither is useful
    // alone. `shop_orders.id` IS the OpenReceive reference: minted before
    // checkout, kept across every retry, never reused.
    //
    // `shop_user_id` is NOT NULL, and there is no `session_token` column in any
    // stack — the signed cookie is the only ownership mechanism, and two
    // sources of ownership truth is the thing this design exists to avoid.
    id: "003_create_shop_orders",
    run: (db) =>
      db.exec(`
        CREATE TABLE shop_orders (
          id           TEXT    PRIMARY KEY NOT NULL,
          shop_user_id TEXT    NOT NULL REFERENCES shop_users (id),
          state        TEXT    NOT NULL DEFAULT 'awaiting_payment'
                               CHECK (state IN ('awaiting_payment', 'paid')),
          total_cents  INTEGER NOT NULL CHECK (total_cents > 0),
          currency     TEXT    NOT NULL DEFAULT 'USD',
          paid_at      INTEGER,
          payment_hash TEXT,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX index_shop_orders_on_shop_user_id ON shop_orders (shop_user_id);
        CREATE INDEX index_shop_orders_on_state_and_created_at
          ON shop_orders (state, created_at);
        -- The public feed's index: paid rows, newest first.
        CREATE INDEX index_shop_orders_on_state_and_paid_at ON shop_orders (state, paid_at);

        CREATE TABLE shop_order_items (
          id               TEXT    PRIMARY KEY NOT NULL,
          shop_order_id    TEXT    NOT NULL REFERENCES shop_orders (id) ON DELETE CASCADE,
          -- Nullable, with the snapshots beside it: the FK is for joins, the
          -- snapshot is what renders. An item row must stay readable after its
          -- product is deleted, and history must not move when the catalog does.
          product_id       TEXT    REFERENCES shop_products (id) ON DELETE SET NULL,
          sku              TEXT    NOT NULL,
          name             TEXT    NOT NULL,
          unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
          quantity         INTEGER NOT NULL CHECK (quantity > 0),
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );
        -- One line per sku per order: normalizedLines merges duplicates, and
        -- this is the database saying so too.
        CREATE UNIQUE INDEX index_shop_order_items_on_order_and_sku
          ON shop_order_items (shop_order_id, sku);
        CREATE INDEX index_shop_order_items_on_product_id ON shop_order_items (product_id);
      `),
  },
  {
    // Both engine-owned tables — the payment attempts and the durable
    // reconcile gate they share — in the host's own database, never a second
    // one.
    //
    // RENDERED BY THE LIBRARY, never hand-written here. `paymentsSchemaSql`
    // is the canonical DDL, so the engine-owned schema stays the engine's to
    // change and this demo cannot drift from it.
    id: "004_create_openreceive_tables",
    run: (db) => db.exec(paymentsSchemaSql("sqlite")),
  },
  {
    // A DATA migration: the six buttons, from the one catalog file. Idempotent
    // by sku so a re-run is a no-op rather than a duplicate-key crash.
    id: "005_seed_shop_products",
    run: (db) => {
      const now = Math.floor(Date.now() / 1_000);
      const insert = db.prepare(
        `INSERT INTO shop_products
           (id, sku, name, price_cents, position, image_name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (sku) DO UPDATE SET
           name = excluded.name,
           price_cents = excluded.price_cents,
           position = excluded.position,
           image_name = excluded.image_name,
           active = 1,
           updated_at = excluded.updated_at`,
      );

      for (const entry of catalogSeedEntries()) {
        insert.run(
          randomUUID(),
          entry.sku,
          entry.name,
          entry.price_cents,
          entry.position,
          entry.image_name ?? defaultImageName(entry.sku),
          now,
          now,
        );
      }
    },
  },
];

