<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

use Joomla\CMS\Factory;
use Joomla\CMS\Session\Session;
use Joomla\CMS\Uri\Uri;
use Joomla\Database\DatabaseInterface;
use OpenReceive\Nwc\Errors;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;

\defined('_JEXEC') or die;

/**
 * Everything the plugin wires into Joomla and HikaShop: the codes in
 * HikaShop's configuration table (sealed with the site's secret), the HikaShop
 * payment method customers pick, the engine's tables in Joomla's database,
 * the checkout HTML and the engine itself.
 */
final class Runtime
{
    public const VERSION = '0.6.3';

    /** The plugin's element: plugins/hikashoppayment/openreceive, and HikaShop's payment_type. */
    public const PLUGIN = 'openreceive';

    public const GROUP = 'hikashoppayment';

    /** Settings that hold a code, and the engine's names for them. */
    public const SECRET_KEYS = ['nwc_uri' => 'NWC_URI', 'lsc_uri_primary' => 'LSC_URI_PRIMARY'];

    /** Where the plugin's settings keep each sealed code. */
    public const CODE_PARAMS = ['nwc_uri' => 'openreceive_nwc_uri', 'lsc_uri_primary' => 'openreceive_lsc_uri_primary'];

    /** Unix seconds of the last finished cron pass, in the plugin's settings. */
    public const CRON_PARAM = 'openreceive_cron_at';

    public const DEFAULT_NAME = 'Bitcoin Lightning';

    public const SWAP_NAME = 'Bitcoin & stablecoins';

    /** The orders this browser may pay, after HikaShop showed it their page. */
    public const SESSION_GRANTS = 'openreceive.orders';

    /** The path the engine sees its routes under; the browser reaches them through HikaShop's notify task. */
    public const ENGINE_PREFIX = '/openreceive';

    /** Where the release installs the checkout's script and stylesheet. */
    public const MEDIA = 'media/plg_hikashoppayment_openreceive';

    private static ?Engine $engine = null;

    private static ?DatabaseConnection $connection = null;

    public static function db(): DatabaseInterface
    {
        return Factory::getContainer()->get(DatabaseInterface::class);
    }

    public static function prefix(): string
    {
        return self::db()->getPrefix();
    }

    /** Loads HikaShop's helpers, which the web pages already loaded and the console has not. */
    public static function hikashop(): void
    {
        if (function_exists('hikashop_config')) {
            return;
        }
        $helper = JPATH_ADMINISTRATOR . '/components/com_hikashop/helpers/helper.php';
        if (!is_file($helper)) {
            throw new \RuntimeException('HikaShop is not installed. Install HikaShop (the free Starter edition is enough) before OpenReceive.');
        }
        if (!defined('DS')) {
            define('DS', DIRECTORY_SEPARATOR);
        }
        require_once $helper;
    }

    /**
     * The console has no visitor. HikaShop's own commands run its code in a
     * site application with a guest identity, as a storefront request would;
     * so do OpenReceive's, so order changes and their emails behave the same.
     */
    public static function bootCli(): void
    {
        $container = Factory::getContainer();
        if (!Factory::$application instanceof \Joomla\CMS\Application\SiteApplication) {
            $app = $container->get(\Joomla\CMS\Application\SiteApplication::class);
            $app->loadIdentity($container->get(\Joomla\CMS\User\UserFactoryInterface::class)->loadUserById(0));
            Factory::$application = $app;
            $app->createExtensionNamespaceMap();
        }
        self::hikashop();
    }

    /** @return list<string> The plugin's own keys in HikaShop's configuration table. */
    public static function paramKeys(): array
    {
        return [...array_values(self::CODE_PARAMS), self::CRON_PARAM];
    }

    /**
     * The plugin's settings, kept in HikaShop's configuration table under
     * their own keys: HikaShop's configuration page saves only the keys it
     * shows, and Joomla's plugin form never sees them.
     *
     * @return array<string, string>
     */
    public static function params(): array
    {
        $keys = self::paramKeys();
        $rows = self::connection()->query(
            'SELECT config_namekey, config_value FROM ' . self::prefix() . 'hikashop_config WHERE config_namekey IN (' . implode(', ', array_fill(0, count($keys), '?')) . ')',
            $keys,
        );
        $params = [];
        foreach ($rows as $row) {
            $params[(string) $row['config_namekey']] = (string) $row['config_value'];
        }
        return $params;
    }

    /** @param array<string, string|int|null> $changes a null value removes the setting */
    public static function saveParams(array $changes): void
    {
        $table = self::prefix() . 'hikashop_config';
        foreach ($changes as $key => $value) {
            if (!in_array($key, self::paramKeys(), true)) {
                throw new \InvalidArgumentException("Not an OpenReceive setting: {$key}");
            }
            if ($value === null) {
                self::connection()->execute('DELETE FROM ' . $table . ' WHERE config_namekey = ?', [$key]);
                continue;
            }
            self::connection()->execute(
                'INSERT INTO ' . $table . ' (config_namekey, config_value, config_default) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
                [$key, (string) $value, ''],
            );
        }
    }

    /** Forgets both codes and the cron time: uninstalling the package removes them. */
    public static function forgetSettings(): void
    {
        self::saveParams(array_fill_keys(self::paramKeys(), null));
        self::$engine = null;
    }

    private static function siteSecret(): string
    {
        return (string) Factory::getApplication()->get('secret');
    }

    /** @return array<string, string> setting name => code, decrypted; '' when unset */
    public static function codes(): array
    {
        $params = self::params();
        $codes = [];
        foreach (self::CODE_PARAMS as $key => $param) {
            $sealed = (string) ($params[$param] ?? '');
            if ($sealed === '') {
                $codes[$key] = '';
                continue;
            }
            $plain = Codes::open($sealed, self::siteSecret());
            if ($plain === null) {
                throw new \RuntimeException('The saved ' . self::SECRET_KEYS[$key] . ' cannot be decrypted with this site\'s secret. Save the code again.');
            }
            $codes[$key] = trim($plain);
        }
        return $codes;
    }

    /**
     * Saves the codes (one or both). A wallet code is saved only after the
     * wallet answered as receive-only. The console command and the payment
     * method's settings page both come here.
     *
     * @param array<string, string> $codes setting name => code; a blank code keeps the saved one
     */
    public static function saveCodes(array $codes): void
    {
        $codes = array_filter(
            array_map(static fn (string $code): string => trim($code), array_intersect_key($codes, self::SECRET_KEYS)),
            static fn (string $code): bool => $code !== '',
        );
        self::migrate();
        if (isset($codes['nwc_uri'])) {
            Service::fromEnvironment(['NWC_URI' => $codes['nwc_uri']] + self::environment(), self::currencies(), walletInfoCacheSeconds: 0);
        }
        $sealed = [];
        foreach ($codes as $key => $code) {
            $sealed[self::CODE_PARAMS[$key]] = Codes::seal($code, self::siteSecret());
        }
        if ($sealed !== []) {
            self::saveParams($sealed);
        }
        self::$engine = null;
    }

    /** Called by `openreceive:reconcile` after each finished pass, so the settings page knows the cron line runs. */
    public static function recordCronRun(): void
    {
        self::saveParams([self::CRON_PARAM => time()]);
    }

    /** Unix seconds of the last finished cron pass; 0 for never. */
    public static function lastCronRun(): int
    {
        return (int) (self::params()[self::CRON_PARAM] ?? 0);
    }

    /** Whether checkout offers the payment method: a wallet code is saved. */
    public static function ready(): bool
    {
        try {
            return self::codes()['nwc_uri'] !== '';
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * The engine's environment: the process environment for OpenReceive's
     * optional knobs, with the codes only from the plugin's settings.
     *
     * @return array<string, mixed>
     */
    public static function environment(): array
    {
        $env = Service::processEnvironment();
        foreach (self::codes() as $key => $code) {
            $env[self::SECRET_KEYS[$key]] = $code;
        }
        unset($env['LSC_URI_BACKUP']);
        return $env;
    }

    /** @return list<string> The shop's published currencies, its main currency first. */
    public static function currencies(): array
    {
        self::hikashop();
        $main = (int) hikashop_config()->get('main_currency', 1);
        $rows = self::connection()->query('SELECT currency_id, currency_code FROM ' . self::prefix() . 'hikashop_currency WHERE currency_published = 1 ORDER BY currency_id');
        $codes = [];
        foreach ($rows as $row) {
            $code = strtoupper((string) $row['currency_code']);
            (int) $row['currency_id'] === $main ? array_unshift($codes, $code) : $codes[] = $code;
        }
        return $codes === [] ? ['USD'] : array_values(array_unique($codes));
    }

    /** @param array<string, mixed>|null $env */
    public static function service(?array $env = null): Service
    {
        return Service::fromEnvironment($env ?? self::environment(), self::currencies(), logger: new Logger());
    }

    public static function table(): string
    {
        return self::prefix() . PaymentsSchema::DEFAULT_TABLE;
    }

    public static function metaTable(): string
    {
        return self::prefix() . PaymentsSchema::DEFAULT_META_TABLE;
    }

    /**
     * Joomla's own database link. The settlement transaction runs on it, so
     * what HikaShop writes inside onPaid commits with the payment row, or
     * rolls back with it.
     */
    public static function connection(): DatabaseConnection
    {
        if (self::$connection !== null) {
            return self::$connection;
        }
        $db = self::db();
        $db->connect();
        $link = $db->getConnection();
        if ($link instanceof \mysqli) {
            return self::$connection = new MysqliConnection($link);
        }
        if ($link instanceof \PDO && $link->getAttribute(\PDO::ATTR_DRIVER_NAME) === 'mysql') {
            return self::$connection = new PdoConnection($link);
        }
        throw new \RuntimeException('HikaShop runs on MySQL or MariaDB; this site\'s database driver is ' . $db->getName() . '.');
    }

    public static function repository(): SqlPaymentRepository
    {
        $repository = new SqlPaymentRepository(self::connection(), null, self::table(), self::metaTable());
        if ($repository->meta()->storedSchemaVersion() !== PaymentsSchema::SCHEMA_VERSION) {
            throw new \RuntimeException('The OpenReceive tables are missing. Run php cli/joomla.php openreceive:configure, or install the OpenReceive package again.');
        }
        return $repository;
    }

    /**
     * Creates the engine's two tables in Joomla's database. Each statement
     * is CREATE TABLE IF NOT EXISTS or an insert that keeps an existing row,
     * so this is safe to repeat.
     */
    public static function migrate(): void
    {
        $connection = self::connection();
        foreach (PaymentsSchema::statements('mysql', self::table(), self::metaTable()) as $statement) {
            $connection->execute(str_starts_with($statement, 'CREATE TABLE') ? $statement . ' ENGINE=InnoDB' : $statement);
        }
    }

    public static function engine(): Engine
    {
        return self::$engine ??= new Engine(
            new Host(),
            self::repository(),
            self::service(),
            clientIp: static fn (): ?string => PHP_SAPI === 'cli' ? '127.0.0.1' : (string) ($_SERVER['REMOTE_ADDR'] ?? ''),
            logger: new Logger(),
            prefix: self::ENGINE_PREFIX,
        );
    }

    /**
     * One gated reconcile pass, then completes any order whose payment
     * settled but did not reach it. Before a wallet code is saved there is
     * nothing to scan.
     */
    public static function reconcile(): void
    {
        Completion::repair();
        if (self::environment()['NWC_URI'] === '') {
            return;
        }
        self::engine()->maybeReconcile();
        Completion::repair();
    }

    /** @return list<string> HikaShop's unpaid statuses: an order in one of them may still be paid. */
    public static function unpaidStatuses(): array
    {
        self::hikashop();
        $config = hikashop_config();
        $statuses = array_map('trim', explode(',', (string) $config->get('order_unpaid_statuses', 'created')));
        return array_values(array_unique(array_filter($statuses, static fn (string $status): bool => $status !== '')));
    }

    /**
     * The HikaShop payment methods made with this plugin.
     *
     * @return list<array{payment_id: int, payment_name: string, payment_published: int, payment_params: string}>
     */
    public static function paymentMethods(): array
    {
        $rows = self::connection()->query(
            'SELECT payment_id, payment_name, payment_published, payment_params FROM ' . self::prefix() . 'hikashop_payment WHERE payment_type = ? ORDER BY payment_ordering, payment_id',
            [self::PLUGIN],
        );
        return array_map(static fn (array $row): array => [
            'payment_id' => (int) $row['payment_id'],
            'payment_name' => (string) $row['payment_name'],
            'payment_published' => (int) $row['payment_published'],
            'payment_params' => (string) $row['payment_params'],
        ], $rows);
    }

    /**
     * Makes the HikaShop payment method customers pick, once: published,
     * for every currency and shipping method. HikaShop's own payment class
     * saves it, as its back office would.
     */
    public static function ensurePaymentMethod(?string $name = null): int
    {
        self::hikashop();
        $methods = self::paymentMethods();
        $name = $name === null ? '' : trim($name);
        $paymentClass = hikashop_get('class.payment');
        if ($methods !== []) {
            $id = $methods[0]['payment_id'];
            if ($name !== '' && $name !== $methods[0]['payment_name']) {
                $paymentClass->save((object) ['payment_id' => $id, 'payment_name' => $name]);
            }
            return $id;
        }
        $params = new \stdClass();
        $params->verified_status = (string) hikashop_config()->get('order_confirmed_status', 'confirmed');
        $element = (object) [
            'payment_type' => self::PLUGIN,
            'payment_name' => $name !== '' ? $name : (self::codes()['lsc_uri_primary'] === '' ? self::DEFAULT_NAME : self::SWAP_NAME),
            'payment_description' => self::methodsLine(),
            'payment_images' => '',
            'payment_published' => 1,
            'payment_params' => $params,
            'payment_shipping_methods' => '',
            'payment_currency' => '',
            'payment_access' => 'all',
        ];
        $id = (int) $paymentClass->save($element);
        if ($id <= 0) {
            throw new \RuntimeException('HikaShop did not save the OpenReceive payment method.');
        }
        return $id;
    }

    /** What checkout says under the payment method's name. */
    public static function methodsLine(): string
    {
        try {
            return self::codes()['lsc_uri_primary'] === ''
                ? 'Pay with Bitcoin over Lightning.'
                : 'Pay with Bitcoin over Lightning, or with USDT, USDC, SOL or ETH.';
        } catch (\Throwable) {
            return 'Pay with Bitcoin over Lightning.';
        }
    }

    /**
     * The checkout for an unpaid order, on a page where HikaShop already
     * checked that this visitor may see the order: its thank-you page (the
     * order's own token, or the signed-in customer) or the order's page in
     * the customer's account. That permission is kept in Joomla's session for
     * the checkout's own requests, which send Joomla's form token back on
     * every write.
     */
    public static function checkoutHtml(int $orderId): string
    {
        $session = Factory::getApplication()->getSession();
        $session->set(self::SESSION_GRANTS, Grants::add((string) $session->get(self::SESSION_GRANTS, ''), $orderId));
        $token = Session::getFormToken();

        $e = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $asset = static fn (string $file): string => $e(rtrim(Uri::root(true), '/') . '/' . self::MEDIA . '/' . $file . '?v=' . self::VERSION);

        return <<<HTML
            <meta name="csrf-token" content="{$e($token)}">
            <link rel="stylesheet" href="{$asset('openreceive-checkout.css')}">
            <script type="module" src="{$asset('openreceive-checkout.js')}"></script>
            <script>
                // The payment is on the order when the checkout reports it settled:
                // load the page again to show it paid. The event does not bubble; a
                // capturing listener still sees it.
                document.addEventListener('openreceive-settled', function () {
                    window.location.reload();
                }, true);
            </script>
            <openreceive-checkout reference="{$e((string) $orderId)}" prefix="{$e(self::apiPrefix())}" resumable="true"></openreceive-checkout>
            HTML;
    }

    /**
     * HikaShop's notify task for this plugin, as a path on the site's own
     * origin with the route in its `path` parameter: the checkout appends
     * each route (`/checkouts`, `/payments/check`, …) to it. Plain query
     * parameters work with Joomla's search-engine-friendly URLs on or off.
     */
    public static function apiPrefix(): string
    {
        $language = strtolower(substr((string) Factory::getApplication()->getLanguage()->getTag(), 0, 2));
        return rtrim(Uri::root(true), '/') . '/index.php?option=com_hikashop&ctrl=checkout&task=notify&notif_payment=' . self::PLUGIN
            . '&tmpl=component&format=raw' . ($language !== '' ? '&lang=' . rawurlencode($language) : '') . '&path=';
    }

    /** An error's message with every saved code removed, safe for a log line or a terminal. */
    public static function errorMessage(\Throwable $error): string
    {
        $message = $error->getMessage();
        try {
            foreach (self::codes() as $code) {
                if (strlen($code) > 4) {
                    $message = str_replace($code, '[REDACTED]', $message);
                }
            }
        } catch (\Throwable) {
            // A database or decryption failure has no code in its text.
        }
        return Errors::redactErrorText($message);
    }
}
