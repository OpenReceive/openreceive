<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

use OpenReceive\Nwc\Errors;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\SqlPaymentRepository;
use Symfony\Component\HttpFoundation\Request;

require_once dirname(__DIR__) . '/autoload.php';

/**
 * Everything the module wires into FOSSBilling: the codes in the module's
 * encrypted settings, the payment gateway row, the engine's tables in
 * FOSSBilling's database, the checkout HTML and the engine itself.
 */
final class Runtime
{
    public const VERSION = '0.4.27';

    /** The module's id: its folder is modules/Openreceive, its URLs start with /openreceive. */
    public const MODULE = 'openreceive';

    /** The key FOSSBilling stores the module's settings under, encrypted with the install's salt. */
    public const CONFIG = 'mod_openreceive';

    /** The payment adapter's code: library/Payment/Adapter/OpenReceive, and the `gateway` column of its row. */
    public const GATEWAY = 'OpenReceive';

    /** Where the payment routes mount, relative to FOSSBilling's root URL. */
    public const PREFIX = '/openreceive/api';

    public const ASSET_PREFIX = '/openreceive/assets';

    /** Settings that hold a code, and the engine's names for them. */
    public const SECRET_KEYS = ['nwc_uri' => 'NWC_URI', 'lsc_uri_primary' => 'LSC_URI_PRIMARY'];

    public const DEFAULT_NAME = 'Bitcoin Lightning';

    public const SWAP_NAME = 'Bitcoin & stablecoins';

    /** The invoices this browser session opened the checkout for, after FOSSBilling allowed it. */
    public const SESSION_GRANTS = 'openreceive_invoices';

    private static ?\Pimple\Container $di = null;

    private static ?Engine $engine = null;

    /** Each entry point (adapter, controller, command, hook) hands over FOSSBilling's container. */
    public static function setDi(\Pimple\Container $di): void
    {
        if (self::$di !== $di) {
            self::$di = $di;
            self::$engine = null;
        }
    }

    public static function di(): \Pimple\Container
    {
        return self::$di ?? throw new \LogicException('OpenReceive was used before FOSSBilling handed it the container.');
    }

    /** @return array<string, mixed> The module's settings, decrypted. */
    public static function settings(): array
    {
        $settings = self::di()['mod_service']('extension')->getConfig(self::CONFIG);
        return is_array($settings) ? $settings : [];
    }

    /**
     * Merges the changes into the module's settings. FOSSBilling encrypts
     * them with its own salt before they reach the database.
     *
     * @param array<string, string> $changes
     */
    public static function saveSettings(array $changes): void
    {
        $settings = self::settings();
        unset($settings['ext']);
        self::di()['mod_service']('extension')->setConfig(['ext' => self::CONFIG] + array_merge($settings, $changes));
    }

    public static function gateway(): ?\Model_PayGateway
    {
        $gateway = self::di()['db']->findOne('PayGateway', 'gateway = :gateway ORDER BY id', [':gateway' => self::GATEWAY]);
        return $gateway instanceof \Model_PayGateway ? $gateway : null;
    }

    /**
     * The payment gateway row, created when missing. It stays disabled, so
     * invoices do not offer it, until a wallet code is saved.
     */
    public static function ensureGateway(): \Model_PayGateway
    {
        $gateway = self::gateway();
        if ($gateway !== null) {
            return $gateway;
        }
        self::di()['mod_service']('Invoice', 'PayGateway')->install(self::GATEWAY);
        $gateway = self::gateway() ?? throw new \RuntimeException('FOSSBilling did not create the OpenReceive payment gateway.');
        $gateway->name = self::DEFAULT_NAME;
        $gateway->allow_single = 1;
        $gateway->allow_recurrent = 0;
        self::di()['db']->store($gateway);
        return $gateway;
    }

    /** Offers the gateway on unpaid invoices. */
    public static function enableGateway(?string $name = null): \Model_PayGateway
    {
        $gateway = self::ensureGateway();
        $gateway->enabled = 1;
        $gateway->allow_single = 1;
        if ($name !== null && trim($name) !== '') {
            $gateway->name = trim($name);
        }
        self::di()['db']->store($gateway);
        return $gateway;
    }

    /**
     * Saves the codes (one or both) and turns the gateway on. A wallet code
     * is saved only after the wallet answered as receive-only. The console
     * command and the settings page both come here.
     *
     * @param array<string, string> $codes setting name => code; a blank code keeps the saved one
     */
    public static function saveCodes(array $codes, ?string $name = null): \Model_PayGateway
    {
        $codes = array_filter(array_map(static fn (string $code): string => trim($code), array_intersect_key($codes, self::SECRET_KEYS)), static fn (string $code): bool => $code !== '');
        self::migrate();
        $gateway = self::ensureGateway();
        if (isset($codes['nwc_uri'])) {
            Service::fromEnvironment(['NWC_URI' => $codes['nwc_uri']] + self::environment(), self::currencies(), walletInfoCacheSeconds: 0);
        }
        if ($codes !== []) {
            self::saveSettings($codes);
        }
        if (($name === null || trim($name) === '') && isset($codes['lsc_uri_primary']) && $gateway->name === self::DEFAULT_NAME) {
            $name = self::SWAP_NAME;
        }
        if (self::environment()['NWC_URI'] !== '') {
            return self::enableGateway($name);
        }
        if ($name !== null && trim($name) !== '') {
            $gateway->name = trim($name);
            self::di()['db']->store($gateway);
        }
        return $gateway;
    }

    /**
     * The engine's environment: the process environment for OpenReceive's
     * optional knobs, with the codes only from the module's settings.
     *
     * @param array<string, mixed>|null $settings
     * @return array<string, mixed>
     */
    public static function environment(?array $settings = null): array
    {
        $env = Service::processEnvironment();
        $settings ??= self::settings();
        foreach (self::SECRET_KEYS as $key => $name) {
            $env[$name] = trim((string) ($settings[$key] ?? ''));
        }
        unset($env['LSC_URI_BACKUP']);
        return $env;
    }

    /** @return list<string> */
    public static function currencies(): array
    {
        $codes = array_map(static fn (mixed $code): string => strtoupper((string) $code), self::di()['dbal']->fetchFirstColumn('SELECT code FROM currency ORDER BY is_default DESC, id'));
        return $codes === [] ? ['USD'] : array_values(array_unique($codes));
    }

    /**
     * PHP builds the service on every request. FOSSBilling's cache keeps the
     * wallet's info event, the BTC price and the swap provider's catalog
     * between requests, so a checkout route does not fetch them each time.
     *
     * @param array<string, mixed>|null $env
     */
    public static function service(?array $env = null): Service
    {
        return Service::fromEnvironment($env ?? self::environment(), self::currencies(), logger: new FossbillingLogger(self::di()['logger']), sharedCache: new FossbillingCache(self::di()['cache']));
    }

    public static function repository(): SqlPaymentRepository
    {
        $repository = new SqlPaymentRepository(new DbalConnection(self::di()['dbal']));
        if ($repository->meta()->storedSchemaVersion() !== PaymentsSchema::SCHEMA_VERSION) {
            throw new \RuntimeException('The OpenReceive tables are missing. Activate the OpenReceive module again, or run php console.php openreceive:configure.');
        }
        return $repository;
    }

    public static function engine(): Engine
    {
        return self::$engine ??= new Engine(
            new Host(),
            self::repository(),
            self::service(),
            clientIp: static fn (mixed $request): ?string => $request instanceof Request ? $request->getClientIp() : Engine::defaultClientIp($request),
            logger: new FossbillingLogger(self::di()['logger']),
            prefix: self::PREFIX,
        );
    }

    /** One gated reconcile pass; nothing to do before a wallet code is saved. */
    public static function reconcile(): void
    {
        if (self::environment()['NWC_URI'] === '') {
            return;
        }
        self::engine()->maybeReconcile();
    }

    /**
     * Creates the engine's two tables in FOSSBilling's database. Each
     * statement is CREATE TABLE IF NOT EXISTS or an insert that keeps an
     * existing row, so this is safe to repeat.
     */
    public static function migrate(): void
    {
        $dbal = self::di()['dbal'];
        foreach (PaymentsSchema::statements('mysql') as $statement) {
            $dbal->executeStatement(str_starts_with($statement, 'CREATE TABLE') ? $statement . ' ENGINE=InnoDB' : $statement);
        }
    }

    /**
     * The checkout on the invoice's payment page. FOSSBilling shows it only
     * after its own check that this visitor may pay the invoice: the client
     * it belongs to, an admin, or a visitor holding the invoice's link when
     * the shop allows paying from the link. That permission is remembered in
     * the session for the checkout's own requests. Its URLs are paths on the
     * page's own origin, and the page's CSRF token rides in a meta tag that
     * the checkout sends back as a header.
     */
    public static function checkoutHtml(\Model_Invoice $invoice): string
    {
        $session = self::di()['session'];
        $grants = $session->get(self::SESSION_GRANTS);
        $grants = is_array($grants) ? $grants : [];
        $grants[(int) $invoice->id] = true;
        $session->set(self::SESSION_GRANTS, $grants);
        $token = $session->get('csrf_token');
        if (!is_string($token) || $token === '') {
            $token = bin2hex(random_bytes(32));
            $session->set('csrf_token', $token);
        }

        $e = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $asset = static fn (string $file): string => $e(self::ASSET_PREFIX . '/' . $file . '?v=' . self::VERSION);
        $returnUrl = '/invoice/' . rawurlencode((string) $invoice->hash);

        return <<<HTML
            <meta name="csrf-token" content="{$e($token)}">
            <link rel="stylesheet" href="{$asset('openreceive-checkout.css')}">
            <script type="module" src="{$asset('openreceive-checkout.js')}"></script>
            <script>
                // The payment is already on the invoice when the checkout reports it
                // settled. The event does not bubble; a capturing listener still sees it.
                document.addEventListener('openreceive-settled', (event) => {
                    const url = event.target?.dataset?.returnUrl;
                    if (url) window.location.assign(url);
                }, true);
            </script>
            <openreceive-checkout reference="{$e((string) $invoice->id)}" prefix="{$e(self::PREFIX)}" resumable="true" data-return-url="{$e($returnUrl)}"></openreceive-checkout>
            HTML;
    }

    /** An error's message with every saved code removed, safe for a log line or a terminal. */
    public static function errorMessage(\Throwable $error): string
    {
        $message = $error->getMessage();
        try {
            foreach (self::SECRET_KEYS as $name) {
                $value = self::environment()[$name] ?? '';
                if (is_string($value) && strlen($value) > 4) {
                    $message = str_replace($value, '[REDACTED]', $message);
                }
            }
        } catch (\Throwable) {
            // A database or decryption failure has no code in its text.
        }
        return Errors::redactErrorText($message);
    }
}
