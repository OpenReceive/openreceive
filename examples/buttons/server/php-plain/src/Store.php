<?php

declare(strict_types=1);

namespace ButtonShop;

use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\PaymentsSchema;

/**
 * The shop's own persistence, on PDO + SQLite: the PHP twin of
 * examples/buttons/shared/server-node/store.ts, table for table.
 *
 * THE DATABASE SURVIVES A RESTART — orders, users and products outlive the
 * process, which is the subject of this demo. OpenReceive never sees anything
 * in this file; the three hooks in public/index.php are the only bridge:
 *   authorize  -> orderByReference + the signed cookie
 *   amountFor  -> orderByReference + checkoutDescription
 *   onPaid     -> claimPaid, through the settlement transaction
 *
 * The engine's two tables live in THIS SAME FILE (migration 004), rendered by
 * the library — PaymentsSchema::statements('sqlite') — never hand-written here.
 */
final class Store
{
    public const MAX_PER_SKU = 10;
    public const FEED_LIMIT = 25;
    public const AWAITING_PAYMENT = 'awaiting_payment';
    public const PAID = 'paid';

    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const SKU = '/^[a-z]+(?:-[a-z]+)*$/';
    /** A page load is a dozen requests; remembering "last seen" must not be a write storm. */
    private const SEEN_THROTTLE_SECONDS = 300;

    public function __construct(public readonly \PDO $pdo, private readonly string $sharedDir)
    {
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $this->migrate();
    }

    /** Where the SQLite file lives: OPENRECEIVE_DEMO_DB (a directory) or examples/buttons/.data. */
    public static function open(string $dataDir, string $sharedDir): self
    {
        if (!is_dir($dataDir) && !mkdir($dataDir, 0o777, true) && !is_dir($dataDir)) {
            throw new \RuntimeException("cannot create {$dataDir}");
        }
        $pdo = new \PDO('sqlite:' . $dataDir . '/php-plain.sqlite');
        $pdo->setAttribute(\PDO::ATTR_TIMEOUT, 5);
        return new self($pdo, $sharedDir);
    }

    public static function isReference(mixed $value): bool
    {
        return is_string($value) && preg_match(self::UUID, $value) === 1;
    }

    /** A decimal string, never a float. The one division, at the edge. */
    public static function formatAmount(int $cents): string
    {
        return sprintf('%d.%02d', intdiv($cents, 100), $cents % 100);
    }

    public static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }

    // ------------------------------------------------------------- catalog

    /** @return list<array<string, mixed>> read FRESH on every call: prices live in a table an operator can edit */
    public function activeCatalog(): array
    {
        return $this->pdo->query('SELECT id, sku, name, price_cents, position, image_name FROM shop_products WHERE active = 1 ORDER BY position, price_cents')->fetchAll();
    }

    /** @return array<string, mixed>|null */
    public function activeProductBySku(mixed $sku): ?array
    {
        if (!is_string($sku) || preg_match(self::SKU, $sku) !== 1) {
            return null;
        }
        $row = $this->one('SELECT id, sku, name, price_cents, position, image_name FROM shop_products WHERE active = 1 AND sku = ?', [$sku]);
        return $row ?: null;
    }

    // --------------------------------------------------------------- users

    /** @return array<string, mixed> two uuids on purpose: `id` rides in the signed cookie, `public_ref` is what the feed shows */
    public function createUser(): array
    {
        $now = time();
        $user = ['id' => self::uuid(), 'public_ref' => self::uuid(), 'first_seen_at' => $now, 'last_seen_at' => $now];
        $this->run('INSERT INTO shop_users (id, public_ref, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [$user['id'], $user['public_ref'], $now, $now, $now, $now]);
        return $user;
    }

    /** @return array<string, mixed>|null a cookie that outlives its row degrades to a NEW visitor, never a 500 */
    public function userById(mixed $id): ?array
    {
        if (!self::isReference($id)) {
            return null;
        }
        return $this->one('SELECT id, public_ref, first_seen_at, last_seen_at FROM shop_users WHERE id = ?', [$id]) ?: null;
    }

    /** @param array<string, mixed> $user */
    public function touchSeen(array $user): void
    {
        $now = time();
        if ($now - (int) $user['last_seen_at'] < self::SEEN_THROTTLE_SECONDS) {
            return;
        }
        $this->run('UPDATE shop_users SET last_seen_at = ? WHERE id = ?', [$now, $user['id']]);
    }

    // -------------------------------------------------------------- orders

    /**
     * THE TRUST BOUNDARY, once: only sku and quantity survive from the cart, each
     * sku is looked up live, the price comes from the row and never the request.
     * Unknown skus are dropped, quantities clamped, duplicates merged, catalog order.
     *
     * @return list<array{product: array<string, mixed>, quantity: int}>
     */
    public function normalizedLines(mixed $requested): array
    {
        if (!is_array($requested)) {
            return [];
        }
        $quantities = [];
        foreach ($requested as $line) {
            if (!is_array($line)) {
                continue;
            }
            $product = $this->activeProductBySku($line['sku'] ?? null);
            if ($product === null) {
                continue;
            }
            $quantity = (int) ($line['quantity'] ?? 0);
            if ($quantity <= 0) {
                continue;
            }
            $existing = $quantities[$product['id']]['quantity'] ?? 0;
            $quantities[$product['id']] = ['product' => $product, 'quantity' => min($existing + $quantity, self::MAX_PER_SKU)];
        }
        $lines = [];
        foreach ($this->activeCatalog() as $product) {
            if (isset($quantities[$product['id']])) {
                $lines[] = $quantities[$product['id']];
            }
        }
        return $lines;
    }

    /**
     * One transaction: the order and every item, the total summed from the
     * PRODUCT rows. Name and unit price are snapshotted onto the item so a
     * catalog edit never rewrites what somebody bought last week.
     *
     * @param list<array{product: array<string, mixed>, quantity: int}> $lines
     * @return array{order: array<string, mixed>, items: list<array<string, mixed>>}
     */
    public function createOrder(array $lines, string $shopUserId): array
    {
        $now = time();
        $id = self::uuid();
        $total = 0;
        foreach ($lines as $line) {
            $total += (int) $line['product']['price_cents'] * $line['quantity'];
        }
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $this->run("INSERT INTO shop_orders (id, shop_user_id, state, total_cents, currency, created_at, updated_at) VALUES (?, ?, ?, ?, 'USD', ?, ?)", [$id, $shopUserId, self::AWAITING_PAYMENT, $total, $now, $now]);
            foreach ($lines as $line) {
                $p = $line['product'];
                $this->run('INSERT INTO shop_order_items (id, shop_order_id, product_id, sku, name, unit_price_cents, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [self::uuid(), $id, $p['id'], $p['sku'], $p['name'], $p['price_cents'], $line['quantity'], $now, $now]);
            }
            $this->pdo->exec('COMMIT');
        } catch (\Throwable $e) {
            $this->pdo->exec('ROLLBACK');
            throw $e;
        }
        return $this->orderByReference($id) ?? throw new \LogicException('order vanished after insert');
    }

    /** @return array{order: array<string, mixed>, items: list<array<string, mixed>>}|null */
    public function orderByReference(mixed $reference): ?array
    {
        if (!self::isReference($reference)) {
            return null;
        }
        $order = $this->one('SELECT id, shop_user_id, state, total_cents, currency, paid_at, payment_hash, created_at FROM shop_orders WHERE id = ?', [$reference]);
        if (!$order) {
            return null;
        }
        return ['order' => $order, 'items' => $this->items($order['id'])];
    }

    /** @return list<array<string, mixed>> */
    private function items(string $orderId): array
    {
        $st = $this->pdo->prepare('SELECT i.id, i.sku, i.name, i.unit_price_cents, i.quantity, p.image_name AS image_name FROM shop_order_items i LEFT JOIN shop_products p ON p.id = i.product_id WHERE i.shop_order_id = ? ORDER BY i.created_at, i.rowid');
        $st->execute([$orderId]);
        return $st->fetchAll();
    }

    /** @return list<array{order: array<string, mixed>, items: list<array<string, mixed>>, buyer: ?string}> paid rows, newest first */
    public function recentOrders(int $limit): array
    {
        $st = $this->pdo->prepare('SELECT o.id, o.shop_user_id, o.state, o.total_cents, o.currency, o.paid_at, o.payment_hash, o.created_at, u.public_ref AS buyer FROM shop_orders o LEFT JOIN shop_users u ON u.id = o.shop_user_id WHERE o.state = ? ORDER BY o.paid_at DESC, o.created_at DESC LIMIT ?');
        $st->bindValue(1, self::PAID);
        $st->bindValue(2, $limit, \PDO::PARAM_INT);
        $st->execute();
        $rows = [];
        foreach ($st->fetchAll() as $row) {
            $buyer = $row['buyer'];
            unset($row['buyer']);
            $rows[] = ['order' => $row, 'items' => $this->items($row['id']), 'buyer' => $buyer];
        }
        return $rows;
    }

    /** @return array{paid_orders: int, buttons_sold: int} */
    public function feedTotals(): array
    {
        $paid = $this->one('SELECT COUNT(*) AS n FROM shop_orders WHERE state = ?', [self::PAID]);
        $sold = $this->one('SELECT COALESCE(SUM(i.quantity), 0) AS n FROM shop_order_items i JOIN shop_orders o ON o.id = i.shop_order_id WHERE o.state = ?', [self::PAID]);
        return ['paid_orders' => (int) ($paid['n'] ?? 0), 'buttons_sold' => (int) ($sold['n'] ?? 0)];
    }

    /**
     * THE GUARDED TRANSITION, idempotent by construction: the WHERE clause is
     * the lock. Runs on the SETTLEMENT TRANSACTION the engine hands `onPaid`,
     * never on the store's own connection, so the order flip and the payment
     * record commit together. True when THIS call claimed the order.
     */
    public static function claimPaid(DatabaseConnection $tx, string $reference, int $paidAt, string $paymentHash): bool
    {
        if (!self::isReference($reference)) {
            return false;
        }
        return $tx->execute("UPDATE shop_orders SET state = 'paid', paid_at = ?, payment_hash = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_payment'", [$paidAt, $paymentHash, time(), $reference]) > 0;
    }

    /** @param array{order: array<string, mixed>, items: list<array<string, mixed>>} $record */
    public static function isPaid(array $record): bool
    {
        return $record['order']['state'] === self::PAID;
    }

    /**
     * What the payer is BUYING, in our own words — the one display string the
     * checkout renders above the amount. Built from the item snapshots.
     *
     * @param array{order: array<string, mixed>, items: list<array<string, mixed>>} $record
     */
    public static function checkoutDescription(array $record): string
    {
        $parts = [];
        $count = 0;
        foreach ($record['items'] as $item) {
            $name = $item['name'] !== '' ? $item['name'] : $item['sku'];
            $parts[] = (int) $item['quantity'] > 1 ? "{$name} ×{$item['quantity']}" : $name;
            $count += (int) $item['quantity'];
        }
        return 'OpenReceive ' . ($count === 1 ? 'button' : 'buttons') . ': ' . implode(', ', $parts);
    }

    // ---------------------------------------------------------- migrations

    /**
     * The schema as a numbered list applied in order at boot — the same five
     * steps, same numbers, as the Node stacks' migrations.ts. SQLite notes:
     * uuids are TEXT, booleans INTEGER 0/1, timestamps INTEGER unix seconds,
     * money INTEGER cents.
     */
    private function migrate(): void
    {
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)');
        $done = array_column($this->pdo->query('SELECT version FROM schema_migrations')->fetchAll(), 'version');
        foreach ($this->migrations() as $id => $run) {
            if (in_array($id, $done, true)) {
                continue;
            }
            $this->pdo->exec('BEGIN IMMEDIATE');
            try {
                $run();
                $this->run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [$id, time()]);
                $this->pdo->exec('COMMIT');
            } catch (\Throwable $e) {
                $this->pdo->exec('ROLLBACK');
                throw $e;
            }
        }
    }

    /** @return array<string, callable(): void> */
    private function migrations(): array
    {
        return [
            '001_create_shop_products' => fn () => $this->pdo->exec(<<<'SQL'
                CREATE TABLE shop_products (
                  id          TEXT    PRIMARY KEY NOT NULL,
                  sku         TEXT    NOT NULL,
                  name        TEXT    NOT NULL,
                  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
                  position    INTEGER NOT NULL DEFAULT 0,
                  image_name  TEXT    NOT NULL,
                  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                  created_at  INTEGER NOT NULL,
                  updated_at  INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX index_shop_products_on_sku ON shop_products (sku);
                CREATE INDEX index_shop_products_on_active_and_position ON shop_products (active, position);
                SQL),
            '002_create_shop_users' => fn () => $this->pdo->exec(<<<'SQL'
                CREATE TABLE shop_users (
                  id            TEXT    PRIMARY KEY NOT NULL,
                  public_ref    TEXT    NOT NULL,
                  first_seen_at INTEGER NOT NULL,
                  last_seen_at  INTEGER NOT NULL,
                  created_at    INTEGER NOT NULL,
                  updated_at    INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX index_shop_users_on_public_ref ON shop_users (public_ref);
                SQL),
            '003_create_shop_orders' => fn () => $this->pdo->exec(<<<'SQL'
                CREATE TABLE shop_orders (
                  id           TEXT    PRIMARY KEY NOT NULL,
                  shop_user_id TEXT    NOT NULL REFERENCES shop_users (id),
                  state        TEXT    NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment', 'paid')),
                  total_cents  INTEGER NOT NULL CHECK (total_cents > 0),
                  currency     TEXT    NOT NULL DEFAULT 'USD',
                  paid_at      INTEGER,
                  payment_hash TEXT,
                  created_at   INTEGER NOT NULL,
                  updated_at   INTEGER NOT NULL
                );
                CREATE INDEX index_shop_orders_on_shop_user_id ON shop_orders (shop_user_id);
                CREATE INDEX index_shop_orders_on_state_and_created_at ON shop_orders (state, created_at);
                CREATE INDEX index_shop_orders_on_state_and_paid_at ON shop_orders (state, paid_at);
                CREATE TABLE shop_order_items (
                  id               TEXT    PRIMARY KEY NOT NULL,
                  shop_order_id    TEXT    NOT NULL REFERENCES shop_orders (id) ON DELETE CASCADE,
                  product_id       TEXT    REFERENCES shop_products (id) ON DELETE SET NULL,
                  sku              TEXT    NOT NULL,
                  name             TEXT    NOT NULL,
                  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
                  quantity         INTEGER NOT NULL CHECK (quantity > 0),
                  created_at       INTEGER NOT NULL,
                  updated_at       INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX index_shop_order_items_on_order_and_sku ON shop_order_items (shop_order_id, sku);
                CREATE INDEX index_shop_order_items_on_product_id ON shop_order_items (product_id);
                SQL),
            // Both engine-owned tables, RENDERED BY THE LIBRARY: the one DDL the host never writes.
            '004_create_openreceive_tables' => function (): void {
                foreach (PaymentsSchema::statements('sqlite') as $statement) {
                    $this->pdo->exec($statement);
                }
            },
            // The six buttons, from the one catalog file every stack seeds from. Idempotent by sku.
            '005_seed_shop_products' => function (): void {
                $entries = json_decode((string) file_get_contents($this->sharedDir . '/shop-catalog.json'), true, 512, JSON_THROW_ON_ERROR);
                $now = time();
                $insert = $this->pdo->prepare('INSERT INTO shop_products (id, sku, name, price_cents, position, image_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (sku) DO UPDATE SET name = excluded.name, price_cents = excluded.price_cents, position = excluded.position, image_name = excluded.image_name, active = 1, updated_at = excluded.updated_at');
                foreach ($entries as $entry) {
                    $insert->execute([self::uuid(), $entry['sku'], $entry['name'], $entry['price_cents'], $entry['position'], $entry['image_name'] ?? "openreceive-{$entry['sku']}-button.webp", $now, $now]);
                }
            },
        ];
    }

    /** @param list<mixed> $params @return array<string, mixed>|false */
    private function one(string $sql, array $params): array|false
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->fetch();
    }

    /** @param list<mixed> $params */
    private function run(string $sql, array $params): void
    {
        $this->pdo->prepare($sql)->execute($params);
    }
}
