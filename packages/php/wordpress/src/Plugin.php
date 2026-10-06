<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use Nyholm\Psr7\ServerRequest;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Psr15Handler;
use OpenReceive\Server\RequestHandler;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\SqlPaymentRepository;

final class Plugin
{
    private static ?Engine $engine = null;

    public static function activate(bool $network = false): void
    {
        if ($network && is_multisite()) {
            foreach (get_sites(['fields' => 'ids', 'number' => 0]) as $id) {
                switch_to_blog($id);
                try { self::install(); } finally { restore_current_blog(); }
            }
        } else { self::install(); }
    }

    public static function install(): void
    {
        global $wpdb;
        if (!$wpdb->is_mysql) { wp_die(esc_html__('OpenReceive requires MySQL or MariaDB; SQLite WordPress is not supported.', 'openreceive')); }
        if (!extension_loaded('sodium') || !extension_loaded('gmp')) { wp_die(esc_html__('OpenReceive requires the PHP sodium and GMP extensions.', 'openreceive')); }
        $db = new WpdbConnection($wpdb);
        foreach (PaymentsSchema::statements('mysql', $wpdb->prefix . 'openreceive_payments', $wpdb->prefix . 'openreceive_meta') as $sql) {
            // MySQL's server default may be MyISAM; settlement needs transactions.
            if (str_starts_with($sql, 'CREATE TABLE')) { $sql .= ' ENGINE=InnoDB'; }
            $db->execute($sql);
        }
    }

    public static function deactivate(bool $network = false): void
    {
        if ($network && is_multisite()) {
            foreach (get_sites(['fields' => 'ids', 'number' => 0]) as $id) {
                switch_to_blog($id);
                try { self::deactivate(); } finally { restore_current_blog(); }
            }
        } elseif (function_exists('as_unschedule_all_actions')) {
            as_unschedule_all_actions('openreceive_reconcile', [], 'openreceive');
        }
    }

    public static function boot(): void
    {
        if (defined('WP_CLI') && WP_CLI) {
            \WP_CLI::add_command('openreceive configure', [new Cli(), 'configure']);
            \WP_CLI::add_command('openreceive doctor', [new Cli(), 'doctor']);
        }
        if (!class_exists('WC_Payment_Gateway')) {
            add_action('admin_notices', static function (): void {
                if (current_user_can('activate_plugins')) { echo '<div class="notice notice-error"><p>' . esc_html__('OpenReceive needs WooCommerce installed and active.', 'openreceive') . '</p></div>'; }
            });
            return;
        }
        // Reject unsupported secret writes before WooCommerce mutates any settings.
        add_filter('rest_pre_dispatch', static function ($result, $server, $request) {
            if (in_array($request->get_method(), ['POST', 'PUT', 'PATCH'], true)
                && preg_match('#^/wc/v[0-9]+/payment_gateways/openreceive/?$#', $request->get_route())) {
                $settings = $request->get_param('settings');
                if (is_array($settings) && array_intersect(array_keys($settings), array_keys(Secrets::FIELDS)) !== []) {
                    return new \WP_Error('openreceive_credentials_cli_required', 'Use wp openreceive configure with stdin, or the OpenReceive admin settings form, to change encrypted credentials.', ['status' => 400]);
                }
            }
            return $result;
        }, 10, 3);
        add_filter('woocommerce_payment_gateways', static function (array $gateways): array { $gateways[] = Gateway::class; return $gateways; });
        add_action('rest_api_init', [self::class, 'routes']);
        add_action('admin_notices', static function (): void {
            if (!current_user_can('manage_woocommerce') || (get_option('woocommerce_openreceive_settings', [])['enabled'] ?? 'no') !== 'yes') { return; }
            try {
                self::repository();
                self::engine()->service()->listRates(['currencies' => [get_woocommerce_currency()]]);
            } catch (\Throwable) {
                echo '<div class="notice notice-error"><p>' . esc_html__('OpenReceive is unavailable. Check its Doctor panel for wallet permissions, database schema and a working price feed for the store currency.', 'openreceive') . '</p></div>';
            }
        });
        add_action('template_redirect', [Gateway::class, 'prepareReceipt']);
        add_action('woocommerce_blocks_loaded', static function (): void {
            add_action('woocommerce_blocks_payment_method_type_registration', static function ($registry): void { $registry->register(new BlocksIntegration()); });
        });
        add_action('action_scheduler_init', static function (): void {
            if (!as_has_scheduled_action('openreceive_reconcile', [], 'openreceive')) {
                as_schedule_recurring_action(time() + 60, 60, 'openreceive_reconcile', [], 'openreceive', true);
            }
        });
        add_action('openreceive_reconcile', [self::class, 'reconcile']);
        add_action('wp_initialize_site', static function ($site): void {
            if (is_plugin_active_for_network(plugin_basename(OPENRECEIVE_PLUGIN_FILE))) {
                switch_to_blog($site->blog_id);
                try { self::install(); } finally { restore_current_blog(); }
            }
        }, 20);
        if (defined('WP_CLI') && WP_CLI) {
            \WP_CLI::add_command('openreceive reconcile', static function (): void { self::reconcile(); \WP_CLI::success('Reconciliation complete.'); });
            \WP_CLI::add_command('openreceive notifications', static function (): void { self::engine()->notificationsWorker()->run(); });
        }
    }

    public static function resetEngine(): void { self::$engine = null; }

    public static function repository(): SqlPaymentRepository
    {
        global $wpdb;
        $repo = new SqlPaymentRepository(new WpdbConnection($wpdb), null, $wpdb->prefix . 'openreceive_payments', $wpdb->prefix . 'openreceive_meta');
        // Fail closed also for missing/corrupt schema markers, not just newer schemas.
        $version = $repo->meta()->storedSchemaVersion();
        if ($version !== PaymentsSchema::SCHEMA_VERSION) { throw new \RuntimeException('OpenReceive schema is missing or incompatible. Reactivate after installing the matching plugin version.'); }
        return $repo;
    }

    public static function service(?array $settings = null): Service
    {
        if (defined('OPENRECEIVE_DEMO_WALLET') && OPENRECEIVE_DEMO_WALLET === 'testkit') { return DemoWallet::service(); }
        return Service::fromEnvironment(Secrets::environment($settings), [get_woocommerce_currency()], http: new WpHttpTransport());
    }

    public static function engine(): Engine
    {
        if (self::$engine === null) {
            $settings = get_option('woocommerce_openreceive_settings', []);
            self::$engine = new Engine(new OrderHost(), self::repository(), self::service(),
                rateLimiting: ($settings['rate_limiting'] ?? 'no') === 'yes',
                clientIp: static fn (): ?string => isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : null,
                prefix: '/openreceive/v1');
        }
        return self::$engine;
    }

    public static function reconcile(): void
    {
        // Repair does not need a working wallet connection.
        OrderHost::repair();
        self::engine()->maybeReconcile();
        OrderHost::repair();
    }

    public static function routes(): void
    {
        // Register all methods so the canonical handler returns its own 405.
        foreach (Psr15Handler::KNOWN_PATHS as $path) {
            register_rest_route('openreceive/v1', $path . '/?', [
                'methods' => \WP_REST_Server::ALLMETHODS, 'permission_callback' => '__return_true',
                'callback' => [self::class, 'dispatch'],
            ]);
        }
        if (defined('OPENRECEIVE_DEMO_WALLET') && OPENRECEIVE_DEMO_WALLET === 'testkit') { DemoWallet::routes(); }
    }

    public static function dispatch(\WP_REST_Request $request): \WP_REST_Response
    {
        try {
            $uri = 'http://localhost' . $request->get_route();
            $query = http_build_query($request->get_query_params());
            if ($query !== '') { $uri .= '?' . $query; }
            $headers = [];
            foreach ($request->get_headers() as $key => $values) { $headers[str_replace('_', '-', $key)] = $values; }
            $psr = (new ServerRequest($request->get_method(), $uri, $headers, $request->get_body()))
                ->withAttribute(RequestHandler::HOST_REQUEST_ATTRIBUTE, $request);
            OrderHost::repair();
            $response = self::engine()->psr15Handler()->handle($psr);
            OrderHost::repair();
            $result = new \WP_REST_Response(json_decode((string) $response->getBody(), true), $response->getStatusCode());
            foreach ($response->getHeaders() as $key => $values) { $result->header($key, implode(', ', $values)); }
            $result->header('Cache-Control', 'no-store');
            return $result;
        } catch (\Throwable) {
            return new \WP_REST_Response(['code' => 'UNAVAILABLE', 'message' => 'Payment service is unavailable. Ask the merchant to check OpenReceive settings.', 'request_id' => 'req_' . wp_generate_uuid4()], 503, ['Cache-Control' => 'no-store']);
        }
    }

    public static function diagnostics(): array { return self::diagnosticReport()['lines']; }

    public static function diagnosticReport(): array
    {
        global $wpdb;
        $lines = [];
        $ok = true;
        $check = static function (string $name, callable $probe) use (&$lines, &$ok): void {
            try { $lines[] = $name . ': ' . $probe(); }
            catch (\Throwable $error) { $ok = false; $lines[] = $name . ': FAILED — ' . Configuration::errorMessage($error); }
        };
        $check('WooCommerce', static function (): string {
            if (!class_exists('WC_Payment_Gateway')) { throw new \RuntimeException('Install and activate WooCommerce.'); }
            return 'active';
        });
        $check('PHP extensions', static function (): string {
            foreach (['gmp', 'sodium'] as $extension) {
                if (!extension_loaded($extension)) { throw new \RuntimeException('Enable PHP ' . esc_html($extension) . ' in both web and WP-CLI runtimes.'); }
            }
            return 'GMP and sodium available';
        });
        $check('Credentials', static function () use (&$lines): string {
            foreach (Secrets::environment() as $name => $value) {
                if ($name === 'NWC_URI' || str_starts_with($name, 'LSC_')) { $lines[] = $name . ': ' . ($value === '' ? 'unset' : 'set'); }
            }
            if (Secrets::environment()['NWC_URI'] === '' && !(defined('OPENRECEIVE_DEMO_WALLET') && OPENRECEIVE_DEMO_WALLET === 'testkit')) { throw new \RuntimeException('NWC_URI is not set. Run wp openreceive configure --nwc-uri=- with the code on stdin.'); }
            return 'readable';
        });
        $check('Schema', static function () use ($wpdb, &$lines): string {
            $repo = self::repository();
            $version = $repo->meta()->storedSchemaVersion();
            $attention = $repo->connection()->query("SELECT reference FROM {$wpdb->prefix}openreceive_payments WHERE status = ? ORDER BY id LIMIT 50", ['attention']);
            $lines[] = 'Attention orders (first 50): ' . implode(', ', array_column($attention, 'reference'));
            $gate = $repo->connection()->query("SELECT value FROM {$wpdb->prefix}openreceive_meta WHERE `key` = ?", ['transaction_scan_gate']);
            $claimed = json_decode($gate[0]['value'] ?? '{}', true)['claimed_at'] ?? null;
            $lines[] = 'Last scan claim: ' . ($claimed ? gmdate('c', (int) $claimed) : 'none');
            return (string) $version;
        });
        if (class_exists('WC_Payment_Gateway')) {
            $service = null;
            $check('Wallet preflight', static function () use (&$service): string { $service = self::service(); return 'passed'; });
            if ($service !== null) {
                $check('Price feed', static function () use ($service): string { $currency = get_woocommerce_currency(); $service->listRates(['currencies' => [$currency]]); return 'available for ' . $currency; });
            } else { $lines[] = 'Price feed: not checked because wallet configuration failed'; }
            $check('Reconcile scheduled', static function (): string {
                if (!function_exists('as_has_scheduled_action') || !as_has_scheduled_action('openreceive_reconcile', [], 'openreceive')) { throw new \RuntimeException('No reconcile action is scheduled. Load WordPress with WooCommerce active.'); }
                return 'yes';
            });
        }
        $lines[] = 'Settled orders awaiting completion are retried on checkout requests and scheduled reconciliation.';
        return ['ok' => $ok, 'lines' => $lines];
    }
}
