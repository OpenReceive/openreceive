<?php
declare(strict_types=1);

// Run by CancelledOrderSettlementTest in a process of its own, because the
// wpdb stand-in the other tests share answers no GET_LOCK. Real Engine, real
// repository and the real StoreHost / OrderHost / EddOrderHost, over SQLite
// with the fake wallet; WooCommerce and Easy Digital Downloads are stand-ins
// holding exactly what those classes read. Prints one JSON object.

namespace {
    define('ABSPATH', __DIR__ . '/');

    final class wpdb
    {
        public string $prefix = 'wp_';
        public string $last_error = '';
        public int $insert_id = 0;
        public function suppress_errors(bool $suppress = true): bool { return false; }
        public function prepare(string $format, mixed $value): string { return "'" . addslashes((string) $value) . "'"; }
        public function query(string $sql): int { return 1; }
        public function get_results(string $sql, string $output): array
        {
            if (str_contains($sql, 'GET_LOCK')) { return [['acquired' => 1]]; }
            if (str_contains($sql, 'RELEASE_LOCK')) { return [['released' => 1]]; }
            if (str_contains($sql, 'edd_ordermeta')) {
                $ids = [];
                foreach (Store::$edd as $id => $order) {
                    if ((Store::$eddMeta[$id]['_openreceive_completion_pending'] ?? null) !== 'yes') { continue; }
                    if (str_contains($sql, "o.status IN ('pending', 'complete')") && !in_array($order->status, ['pending', 'complete'], true)) { continue; }
                    $ids[] = $id;
                }
                sort($ids);
                return array_map(static fn (int $id): array => ['edd_order_id' => (string) $id], array_slice($ids, 0, 50));
            }
            throw new \LogicException('unexpected wpdb query: ' . $sql);
        }
    }
    const ARRAY_A = 'ARRAY_A';

    class WC_Payment_Gateway {}

    final class WC_Order
    {
        public array $meta = [];
        public array $completions = [];
        public array $notes = [];

        public function __construct(public int $id, public string $status, public string $total = '7.00') {}
        public function get_id(): int { return $this->id; }
        public function get_status(): string { return $this->status; }
        public function get_payment_method(): string { return 'openreceive'; }
        public function get_customer_id(): int { return 77; }
        public function get_currency(): string { return 'USD'; }
        public function get_total(): string { return $this->total; }
        public function get_order_number(): string { return (string) $this->id; }
        public function needs_payment(): bool { return in_array($this->status, ['pending', 'failed'], true) && (float) $this->total > 0; }
        public function is_paid(): bool { return in_array($this->status, ['processing', 'completed'], true); }
        public function update_meta_data(string $key, mixed $value): void { $this->meta[$key] = $value; }
        public function delete_meta_data(string $key): void { unset($this->meta[$key]); }
        public function save_meta_data(): void {}
        public function get_meta(string $key): mixed { return $this->meta[$key] ?? ''; }
        public function add_order_note(string $note): void { $this->notes[] = $note; }
        public function payment_complete(string $hash): void
        {
            $this->completions[] = $hash;
            $this->status = 'processing';
        }
    }

    /** The two stores' tables. */
    final class Store
    {
        /** @var array<int, WC_Order> */
        public static array $wc = [];
        /** @var array<int, \EDD\Orders\Order> */
        public static array $edd = [];
        /** @var array<int, array<string, string>> */
        public static array $eddMeta = [];
        /** @var array<int, list<string>> */
        public static array $eddNotes = [];

        public static function reset(): void
        {
            self::$wc = [];
            self::$edd = [];
            self::$eddMeta = [];
            self::$eddNotes = [];
        }
    }

    function wc_get_order(int $id): WC_Order|false { return Store::$wc[$id] ?? false; }
    function wc_get_orders(array $query): array
    {
        $found = array_filter(Store::$wc, static fn (WC_Order $order): bool =>
            in_array($order->status, $query['status'], true) && ($order->meta[$query['meta_key']] ?? null) === $query['meta_value']);
        ksort($found);
        return array_slice(array_values($found), 0, $query['limit']);
    }
    function get_current_user_id(): int { return 77; }
    function __(string $text, string $domain = 'default'): string { return $text; }

    function edd_get_order(int $id): ?\EDD\Orders\Order { return Store::$edd[$id] ?? null; }
    function edd_currency_decimal_filter(int $decimals, string $currency): int { return 2; }
    function edd_update_order_meta(int $id, string $key, mixed $value): void { Store::$eddMeta[$id][$key] = (string) $value; }
    function edd_get_order_meta(int $id, string $key, bool $single = false): mixed { return Store::$eddMeta[$id][$key] ?? ''; }
    function edd_delete_order_meta(int $id, string $key): void { unset(Store::$eddMeta[$id][$key]); }
    function edd_update_order_status(int $id, string $status): void { Store::$edd[$id]->status = $status; }
    function edd_set_payment_transaction_id(int $id, string $hash): void {}
    function edd_insert_payment_note(int $id, string $note): void { Store::$eddNotes[$id][] = $note; }
}

namespace EDD\Orders {
    final class Order
    {
        public string $gateway = 'openreceive';
        public string $type = 'sale';
        public string $currency = 'USD';
        public string $total = '7.00';
        public string $payment_key = 'key';
        public int $user_id = 77;

        public function __construct(public int $id, public string $status) {}
        public function get_number(): string { return (string) $this->id; }
    }
}

namespace {
    use Nyholm\Psr7\Factory\Psr17Factory;
    use OpenReceive\Server\Engine;
    use OpenReceive\Server\Service;
    use OpenReceive\Storage\PaymentsSchema;
    use OpenReceive\Storage\PdoConnection;
    use OpenReceive\Storage\SqlPaymentRepository;
    use OpenReceive\Testing\FakeWallet;
    use OpenReceive\WP\EddOrderHost;
    use OpenReceive\WP\StoreHost;
    use Psr\Log\AbstractLogger;

    require dirname(__DIR__) . '/vendor/autoload.php';

    /** A shop over a fresh SQLite database; `run(...)` settles what is due and returns a row reader. */
    final class Shop
    {
        public int $now = 1_700_000_000;
        public FakeWallet $wallet;
        public SqlPaymentRepository $repository;
        public Engine $engine;
        /** @var list<string> */
        public array $logs = [];

        public function __construct()
        {
            $GLOBALS['wpdb'] = new wpdb();
            Store::reset();
            $clock = fn (): int => $this->now;
            $this->wallet = new FakeWallet($clock);
            $db = new PdoConnection(new \PDO('sqlite::memory:'));
            PaymentsSchema::migrate($db);
            $this->repository = new SqlPaymentRepository($db, $clock);
            $service = new Service($this->wallet, false, [], ['USD'], $clock);
            $logs = &$this->logs;
            $logger = new class ($logs) extends AbstractLogger {
                /** @param list<string> $lines */
                public function __construct(private array &$lines) {}
                public function log($level, string|\Stringable $message, array $context = []): void { $this->lines[] = "{$level}: {$message}"; }
            };
            $this->engine = new Engine(new StoreHost(), $this->repository, $service, true, false, null, null, $logger, '/openreceive/v1', new Psr17Factory());
        }

        /** @return array<string, mixed> the committed checkout */
        public function mint(string $reference): array
        {
            $checkout = $this->engine->service()->createCheckout(['reference' => $reference, 'amount' => ['sats' => 100]]);
            $this->repository->commitAttempt($reference, $checkout['payment_hash'], $checkout);
            return $checkout;
        }

        public function pay(string $hash): void
        {
            $this->wallet->settleInvoice($hash, $this->now + 1);
        }

        /** A reconcile pass past the gate, then the store's repair, as a scheduled run does. */
        public function pass(): string
        {
            $this->now += 15;
            $reason = (string) $this->engine->maybeReconcile()['reason'];
            StoreHost::repair();
            return $reason;
        }

        public function status(string $hash): ?string
        {
            return $this->repository->findByPaymentHash($hash)?->status;
        }

        /** @return list<string> */
        public function warnings(): array
        {
            return array_values(array_filter($this->logs, static fn (string $line): bool => str_starts_with($line, 'warning: ') || str_starts_with($line, 'error: ')));
        }
    }

    /** A merchant cancels a WooCommerce order, then the invoice settles. */
    function wooCancelled(): array
    {
        $shop = new Shop();
        $order = Store::$wc[1] = new WC_Order(1, 'pending');
        $invoice = $shop->mint('1');
        $order->status = 'cancelled';
        $amount = (new StoreHost())->amountFor('1');
        $shop->pay($invoice['payment_hash']);
        $shop->pass();
        $shop->pass();
        return [
            'amount_for_after_cancel' => $amount,
            'row' => $shop->status($invoice['payment_hash']),
            'order_status' => $order->status,
            'payment_complete_calls' => count($order->completions),
            'marker' => $order->meta['_openreceive_completion_pending'] ?? null,
            'hash_recorded' => ($order->meta['_openreceive_payment_hash'] ?? null) === $invoice['payment_hash'],
            'notes' => $order->notes,
            'logs' => $shop->logs,
        ];
    }

    /** A merchant reopens a cancelled order whose payment already arrived. */
    function wooCancelledThenReopened(): array
    {
        $shop = new Shop();
        $order = Store::$wc[1] = new WC_Order(1, 'pending');
        $invoice = $shop->mint('1');
        $order->status = 'cancelled';
        $shop->pay($invoice['payment_hash']);
        $shop->pass();
        $order->status = 'pending';
        StoreHost::repair();
        return ['order_status' => $order->status, 'payment_complete_calls' => count($order->completions), 'marker' => $order->meta['_openreceive_completion_pending'] ?? null];
    }

    /** The WooCommerce order is deleted outright; another order settles in the same passes. */
    function wooDeleted(): array
    {
        $shop = new Shop();
        Store::$wc[1] = new WC_Order(1, 'pending');
        $doomed = $shop->mint('1');
        $live = Store::$wc[2] = new WC_Order(2, 'pending');
        $liveInvoice = $shop->mint('2');
        unset(Store::$wc[1]);
        $shop->pay($doomed['payment_hash']);
        $shop->pay($liveInvoice['payment_hash']);
        $reasons = [$shop->pass(), $shop->pass(), $shop->pass()];
        return [
            'row' => $shop->status($doomed['payment_hash']),
            'live_row' => $shop->status($liveInvoice['payment_hash']),
            'live_order' => $live->status,
            'reasons' => $reasons,
            'warning' => $shop->warnings()[0] ?? null,
            'warning_count' => count($shop->warnings()),
        ];
    }

    /** An Easy Digital Downloads order is revoked, then the invoice settles. */
    function eddRevoked(): array
    {
        $shop = new Shop();
        $order = Store::$edd[1] = new \EDD\Orders\Order(1, 'pending');
        $reference = EddOrderHost::reference(1);
        $invoice = $shop->mint($reference);
        $order->status = 'revoked';
        $amount = (new StoreHost())->amountFor($reference);
        $shop->pay($invoice['payment_hash']);
        $shop->pass();
        $shop->pass();
        return [
            'amount_for_after_cancel' => $amount,
            'row' => $shop->status($invoice['payment_hash']),
            'order_status' => $order->status,
            'marker' => Store::$eddMeta[1]['_openreceive_completion_pending'] ?? null,
            'hash_recorded' => (Store::$eddMeta[1]['_openreceive_payment_hash'] ?? null) === $invoice['payment_hash'],
            'notes' => Store::$eddNotes[1] ?? [],
            'logs' => $shop->logs,
        ];
    }

    /** The EDD order row is gone. */
    function eddDeleted(): array
    {
        $shop = new Shop();
        Store::$edd[1] = new \EDD\Orders\Order(1, 'pending');
        $reference = EddOrderHost::reference(1);
        $invoice = $shop->mint($reference);
        unset(Store::$edd[1]);
        $shop->pay($invoice['payment_hash']);
        $shop->pass();
        return ['row' => $shop->status($invoice['payment_hash']), 'warning' => $shop->warnings()[0] ?? null];
    }

    /**
     * 50 revoked orders with stuck markers sit ahead, by order id, of one
     * recoverable order: repair reads the 50 oldest markers each pass.
     */
    function eddStuckMarkersAheadOfARecoverableOrder(): array
    {
        $shop = new Shop();
        for ($id = 1; $id <= 50; $id++) {
            $stuck = Store::$edd[$id] = new \EDD\Orders\Order($id, 'pending');
            $reference = EddOrderHost::reference($id);
            $invoice = $shop->mint($reference);
            $stuck->status = 'revoked';
            $shop->pay($invoice['payment_hash']);
        }
        $shop->pass();
        $order = Store::$edd[51] = new \EDD\Orders\Order(51, 'pending');
        // The settlement committed and the process died before afterPaid.
        $reference = EddOrderHost::reference(51);
        $invoice = $shop->mint($reference);
        $shop->repository->markPaidOnce($invoice['payment_hash'], $shop->now, null, [new StoreHost(), 'onPaid']);
        for ($pass = 0; $pass < 3; $pass++) { StoreHost::repair(); }
        return ['stuck_markers' => count(array_filter(Store::$eddMeta, static fn (array $meta): bool => ($meta['_openreceive_completion_pending'] ?? '') === 'yes')), 'recoverable_status' => $order->status];
    }

    $scenarios = ['wooCancelled', 'wooCancelledThenReopened', 'wooDeleted', 'eddRevoked', 'eddDeleted', 'eddStuckMarkersAheadOfARecoverableOrder'];
    $results = [];
    foreach ($scenarios as $scenario) { $results[$scenario] = $scenario(); }
    echo json_encode($results, JSON_THROW_ON_ERROR), "\n";
}
