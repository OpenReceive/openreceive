<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Server\Service;
use OpenReceive\Testing\FakeWallet;
use OpenReceive\Testing\FakeSwapProvider;

/** Explicit testkit mode only; state is a test fixture outside the web root. */
final class DemoWallet
{
    private static ?self $instance = null;
    private FakeWallet $wallet;
    private FakeSwapProvider $swap;
    private $lock;
    private string $file;

    private function __construct()
    {
        if (!defined('OPENRECEIVE_DEMO_WALLET') || OPENRECEIVE_DEMO_WALLET !== 'testkit') { throw new \LogicException('Testkit is disabled.'); }
        $directory = getenv('OPENRECEIVE_TESTKIT_DIR') ?: sys_get_temp_dir();
        $this->file = $directory . '/openreceive-wp-testkit-' . get_current_blog_id() . '.json';
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen -- Explicit local testkit needs flock; WP_Filesystem offers no interprocess lock API.
        $this->lock = fopen($this->file . '.lock', 'c');
        if (!$this->lock || !flock($this->lock, LOCK_EX)) { throw new \RuntimeException('Cannot lock demo wallet.'); }
        $this->wallet = new FakeWallet();
        $this->swap = new FakeSwapProvider();
        $state = is_file($this->file) ? json_decode((string) file_get_contents($this->file), true, 512, JSON_THROW_ON_ERROR) : [];
        foreach (['wallet', 'swap'] as $name) {
            foreach ($state[$name] ?? [] as $key => $value) { (new \ReflectionProperty($this->$name, $key))->setValue($this->$name, $value); }
        }
        register_shutdown_function(function (): void {
            $state = [];
            foreach (['wallet', 'swap'] as $name) {
                foreach ((new \ReflectionObject($this->$name))->getProperties() as $property) {
                    if ($property->isReadOnly() || $property->isStatic() || !$property->isInitialized($this->$name)) { continue; }
                    $value = $property->getValue($this->$name);
                    if (in_array($property->getName(), ['clock', 'subscribers', 'runtime'], true) || $value instanceof \Closure || is_object($value)) { continue; }
                    $state[$name][$property->getName()] = $value;
                }
            }
            file_put_contents($this->file, json_encode($state, JSON_THROW_ON_ERROR));
            flock($this->lock, LOCK_UN);
            // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- Release the explicit local testkit flock handle.
            fclose($this->lock);
        });
    }

    public static function service(): Service
    {
        $demo = self::$instance ??= new self();
        return new Service($demo->wallet, new StaticPriceProvider(), [$demo->swap], [get_woocommerce_currency()]);
    }

    public static function routes(): void
    {
        foreach (['state', 'settle', 'expire', 'swap-step'] as $action) {
            register_rest_route('openreceive/testkit', '/' . $action, [
                'methods' => $action === 'state' ? 'GET' : 'POST', 'permission_callback' => '__return_true',
                'callback' => static function (\WP_REST_Request $request) use ($action): \WP_REST_Response {
                    $demo = self::$instance ??= new self();
                    try {
                        if ($action === 'state') { return new \WP_REST_Response(['wallet' => ['invoices' => $demo->wallet->listInvoices()], 'swap' => $demo->swap->counters()]); }
                        $body = $request->get_json_params() ?? [];
                        if ($action === 'swap-step') {
                            $selector = array_intersect_key($body, array_flip(['pay_in_asset', 'provider_order_id']));
                            $state = (string) ($body['state'] ?? '');
                            if ($state === 'refund_required') { $demo->swap->forceRefundRequired($selector); }
                            else { $demo->swap->script($selector, [$state]); }
                        } else {
                            $hash = (string) ($body['payment_hash'] ?? '');
                            if ($action === 'settle') { $demo->wallet->settleInvoice($hash); }
                            else { $demo->wallet->expireInvoice($hash); }
                        }
                        return new \WP_REST_Response(['ok' => true]);
                    } catch (\Throwable) { return new \WP_REST_Response(['code' => 'INVALID_REQUEST', 'message' => 'Invalid testkit operation.'], 400); }
                },
            ]);
        }
    }
}
