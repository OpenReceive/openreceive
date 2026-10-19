<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

use OpenReceive\Nwc\Errors;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;

/**
 * Everything the module wires into PrestaShop: the codes in its encrypted
 * configuration, the order state an unpaid order waits in, the engine's
 * tables in PrestaShop's database, the checkout HTML and the engine itself.
 */
final class Runtime
{
    public const VERSION = '0.4.29';

    /** The module's name: its folder is modules/openreceive. */
    public const MODULE = 'openreceive';

    /** Settings that hold a code, and the engine's names for them. */
    public const SECRET_KEYS = ['nwc_uri' => 'NWC_URI', 'lsc_uri_primary' => 'LSC_URI_PRIMARY'];

    /** Where PrestaShop's configuration keeps each code, encrypted with the shop's own key. */
    public const CODE_SETTINGS = ['nwc_uri' => 'OPENRECEIVE_NWC_URI', 'lsc_uri_primary' => 'OPENRECEIVE_LSC_URI_PRIMARY'];

    /** The payment option's name at checkout, on the order and on its invoice. */
    public const NAME_SETTING = 'OPENRECEIVE_NAME';

    /** The id of the order state an order waits in until its payment settles. */
    public const AWAITING_SETTING = 'OPENRECEIVE_OS_AWAITING';

    public const DEFAULT_NAME = 'Bitcoin Lightning';

    public const SWAP_NAME = 'Bitcoin & stablecoins';

    public const AWAITING_NAME = 'Awaiting Bitcoin payment';

    /** The orders this browser may pay, after PrestaShop showed it their page. */
    public const COOKIE_GRANTS = 'openreceive_orders';

    /** The token the checkout sends back with each write, kept in the shop's encrypted cookie. */
    public const COOKIE_CSRF = 'openreceive_csrf';

    /** The path the engine sees its routes under; the browser reaches them through the api front controller. */
    public const ENGINE_PREFIX = '/openreceive';

    private static ?Engine $engine = null;

    /** @return array<string, string> setting name => code, decrypted; '' when unset */
    public static function codes(): array
    {
        $codes = [];
        foreach (self::CODE_SETTINGS as $key => $setting) {
            $stored = (string) \Configuration::getGlobalValue($setting);
            if ($stored === '') {
                $codes[$key] = '';
                continue;
            }
            $plain = (new \PhpEncryption(_NEW_COOKIE_KEY_))->decrypt($stored);
            if (!is_string($plain)) {
                throw new \RuntimeException('The saved ' . self::SECRET_KEYS[$key] . ' cannot be decrypted with this shop\'s key. Save the code again.');
            }
            $codes[$key] = trim($plain);
        }
        return $codes;
    }

    /**
     * Saves the codes (one or both) and returns the payment option's name. A
     * wallet code is saved only after the wallet answered as receive-only.
     * The console command and the settings page both come here.
     *
     * @param array<string, string> $codes setting name => code; a blank code keeps the saved one
     */
    public static function saveCodes(array $codes, ?string $name = null): string
    {
        $codes = array_filter(
            array_map(static fn (string $code): string => trim($code), array_intersect_key($codes, self::SECRET_KEYS)),
            static fn (string $code): bool => $code !== '',
        );
        self::migrate();
        self::ensureAwaitingState();
        if (isset($codes['nwc_uri'])) {
            Service::fromEnvironment(['NWC_URI' => $codes['nwc_uri']] + self::environment(), self::currencies(), walletInfoCacheSeconds: 0);
        }
        $cipher = new \PhpEncryption(_NEW_COOKIE_KEY_);
        foreach ($codes as $key => $code) {
            \Configuration::updateGlobalValue(self::CODE_SETTINGS[$key], $cipher->encrypt($code));
        }
        $name = $name === null ? '' : trim($name);
        if ($name === '' && isset($codes['lsc_uri_primary']) && self::paymentName() === self::DEFAULT_NAME) {
            $name = self::SWAP_NAME;
        }
        if ($name !== '') {
            \Configuration::updateGlobalValue(self::NAME_SETTING, $name);
        }
        self::$engine = null;
        return self::paymentName();
    }

    /** Forgets both codes: uninstalling the module removes them. */
    public static function forgetCodes(): void
    {
        foreach (self::CODE_SETTINGS as $setting) {
            \Configuration::deleteByName($setting);
        }
        self::$engine = null;
    }

    public static function paymentName(): string
    {
        $name = trim((string) \Configuration::getGlobalValue(self::NAME_SETTING));
        return $name === '' ? self::DEFAULT_NAME : $name;
    }

    /** Whether checkout offers the payment option: a wallet code is saved. */
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
     * optional knobs, with the codes only from the module's settings.
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

    /** @return list<string> The shop's active currencies, the default first. */
    public static function currencies(): array
    {
        $default = (int) \Configuration::get('PS_CURRENCY_DEFAULT');
        $rows = \Db::getInstance()->executeS('SELECT id_currency, iso_code FROM `' . _DB_PREFIX_ . 'currency` WHERE active = 1 AND deleted = 0 ORDER BY id_currency');
        $codes = [];
        foreach (is_array($rows) ? $rows : [] as $row) {
            $code = strtoupper((string) $row['iso_code']);
            (int) $row['id_currency'] === $default ? array_unshift($codes, $code) : $codes[] = $code;
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
        return _DB_PREFIX_ . PaymentsSchema::DEFAULT_TABLE;
    }

    public static function metaTable(): string
    {
        return _DB_PREFIX_ . PaymentsSchema::DEFAULT_META_TABLE;
    }

    /**
     * PrestaShop's own database connection. The settlement transaction runs
     * on it, so PrestaShop's writes inside onPaid (the order's payment) commit
     * with the payment row, or roll back with it.
     */
    public static function connection(): PdoConnection
    {
        $link = \Db::getInstance()->getLink();
        if (!$link instanceof \PDO) {
            throw new \RuntimeException('PrestaShop\'s database connection is not PDO.');
        }
        return new PdoConnection($link);
    }

    public static function repository(): SqlPaymentRepository
    {
        $repository = new SqlPaymentRepository(self::connection(), null, self::table(), self::metaTable());
        if ($repository->meta()->storedSchemaVersion() !== PaymentsSchema::SCHEMA_VERSION) {
            throw new \RuntimeException('The OpenReceive tables are missing. Reset the OpenReceive module in Modules > Module Manager, or run php bin/console openreceive:configure.');
        }
        return $repository;
    }

    /**
     * Creates the engine's two tables in PrestaShop's database. Each statement
     * is CREATE TABLE IF NOT EXISTS or an insert that keeps an existing row, so
     * this is safe to repeat.
     */
    public static function migrate(): void
    {
        $connection = self::connection();
        foreach (PaymentsSchema::statements('mysql', self::table(), self::metaTable()) as $statement) {
            $connection->execute(str_starts_with($statement, 'CREATE TABLE') ? $statement . ' ENGINE=' . _MYSQL_ENGINE_ : $statement);
        }
    }

    public static function engine(): Engine
    {
        return self::$engine ??= new Engine(
            new Host(),
            self::repository(),
            self::service(),
            clientIp: static fn (): ?string => PHP_SAPI === 'cli' ? '127.0.0.1' : (string) \Tools::getRemoteAddr(),
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

    /** The id of the order state an unpaid order waits in, or 0 before the module made it. */
    public static function awaitingState(): int
    {
        return (int) \Configuration::getGlobalValue(self::AWAITING_SETTING);
    }

    /**
     * The module's own order state: not paid, not logable, no email, so the
     * order counts as a sale only once PrestaShop's own "Payment accepted"
     * replaces it. Kept on uninstall, since orders refer to it.
     */
    public static function ensureAwaitingState(): int
    {
        $id = self::awaitingState();
        if ($id > 0 && \Validate::isLoadedObject(new \OrderState($id))) {
            return $id;
        }
        $state = new \OrderState();
        $state->name = [];
        foreach (\Language::getLanguages(false) as $language) {
            $state->name[(int) $language['id_lang']] = self::AWAITING_NAME;
        }
        $state->module_name = self::MODULE;
        $state->color = '#F7931A';
        $state->send_email = false;
        $state->invoice = false;
        $state->logable = false;
        $state->paid = false;
        $state->shipped = false;
        $state->delivery = false;
        $state->hidden = false;
        $state->unremovable = true;
        if (!$state->add()) {
            throw new \RuntimeException('PrestaShop did not save the "' . self::AWAITING_NAME . '" order state.');
        }
        \Configuration::updateGlobalValue(self::AWAITING_SETTING, (int) $state->id);
        return (int) $state->id;
    }

    /**
     * The checkout for an unpaid order, on a page where PrestaShop already
     * checked that this visitor may see the order: its order confirmation
     * (the order's secure key), the signed-in customer's order page, or guest
     * order tracking (the order reference and email). That permission is kept
     * in PrestaShop's encrypted cookie for the checkout's own requests, with
     * a token the checkout sends back on every write.
     */
    public static function checkoutHtml(\Order $order, string $moduleUri): string
    {
        $cookie = \Context::getContext()->cookie;
        $cookie->{self::COOKIE_GRANTS} = Grants::add((string) $cookie->{self::COOKIE_GRANTS}, (int) $order->id);
        $token = (string) $cookie->{self::COOKIE_CSRF};
        if (!preg_match('/\A[0-9a-f]{64}\z/', $token)) {
            $token = bin2hex(random_bytes(32));
            $cookie->{self::COOKIE_CSRF} = $token;
        }

        $e = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $asset = static fn (string $file): string => $e(rtrim($moduleUri, '/') . '/views/assets/' . $file . '?v=' . self::VERSION);

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
            <openreceive-checkout reference="{$e((string) $order->id)}" prefix="{$e(self::apiPrefix())}" resumable="true"></openreceive-checkout>
            HTML;
    }

    /**
     * The api front controller's address, as a path on the shop's own origin
     * with the route in its `path` parameter: the checkout appends each route
     * (`/checkouts`, `/payments/check`, …) to it. That works with and without
     * PrestaShop's friendly URLs.
     */
    public static function apiPrefix(): string
    {
        $url = \Context::getContext()->link->getModuleLink(self::MODULE, 'api', [], null);
        $parts = parse_url($url);
        $prefix = ($parts['path'] ?? '/') . (isset($parts['query']) ? '?' . $parts['query'] . '&' : '?');
        return $prefix . 'path=';
    }

    /**
     * The console has no visitor: give PrestaShop's context the default
     * shop, language, currency and country, which order state changes and
     * their emails read.
     */
    public static function cliContext(): void
    {
        $context = \Context::getContext();
        if (!isset($context->shop) || !\Validate::isLoadedObject($context->shop)) {
            $context->shop = new \Shop((int) \Configuration::get('PS_SHOP_DEFAULT'));
        }
        \Shop::setContext(\Shop::CONTEXT_SHOP, (int) $context->shop->id);
        if (!isset($context->language) || !\Validate::isLoadedObject($context->language)) {
            $context->language = new \Language((int) \Configuration::get('PS_LANG_DEFAULT'));
        }
        if (!isset($context->currency) || !\Validate::isLoadedObject($context->currency)) {
            $context->currency = \Currency::getDefaultCurrency();
        }
        if (!isset($context->country) || !\Validate::isLoadedObject($context->country)) {
            $context->country = new \Country((int) \Configuration::get('PS_COUNTRY_DEFAULT'));
        }
        if (!isset($context->link)) {
            $context->link = new \Link();
        }
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
