<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive\Commands;

use OpenReceive\Server\Service;
use OpenReceive\Storage\MetaStore;
use OpenReceive\Swap\SwapProvider;
use PrestaShop\Module\OpenReceive\Requirements;
use PrestaShop\Module\OpenReceive\Runtime;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * `php bin/console openreceive:doctor` — the install state in one command:
 * the module, the PHP requirements, each code as set or unset (never its
 * value), the order state, the payment option, the tables, the checkout
 * files, the wallet, the price feed, each swap provider and the last
 * reconcile pass. Exits 1 when a check fails.
 */
#[AsCommand(name: 'openreceive:doctor', description: 'Check OpenReceive\'s install: module, codes (set or unset only), order state, tables, wallet, prices, swaps, reconcile')]
final class Doctor extends Command
{
    /** @var list<string> */
    private array $lines = [];

    private bool $ok = true;

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        Runtime::cliContext();
        $this->check('Module', static function (): string {
            if (!\Module::isInstalled(Runtime::MODULE)) {
                throw new \RuntimeException('not installed. Install it: php bin/console prestashop:module install openreceive');
            }
            if (!\Module::isEnabled(Runtime::MODULE)) {
                throw new \RuntimeException('installed but disabled. Enable it in Modules > Module Manager, or: php bin/console prestashop:module enable openreceive');
            }
            return 'installed and enabled, version ' . Runtime::VERSION;
        });
        $this->check('Requirements', static function (): string {
            $missing = Requirements::missing();
            if ($missing !== []) {
                throw new \RuntimeException('missing ' . implode(', ', $missing) . '. The web server\'s PHP and the command-line PHP both need them.');
            }
            return '64-bit PHP ' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION . ' with GMP and sodium';
        });
        $env = null;
        $this->check('Codes', function () use (&$env): string {
            $env = Runtime::environment();
            foreach (Runtime::SECRET_KEYS as $name) {
                $this->lines[] = '  ' . $name . ': ' . ($env[$name] === '' ? 'unset' : 'set');
            }
            if ($env['NWC_URI'] === '') {
                throw new \RuntimeException('NWC_URI is not set. Save it on the module\'s Configure page, or pipe it in: php bin/console openreceive:configure --nwc-uri=- < /path/to/code-file');
            }
            return 'readable';
        });
        $this->check('Order state', static function (): string {
            $id = Runtime::awaitingState();
            if ($id === 0 || !\Validate::isLoadedObject(new \OrderState($id))) {
                throw new \RuntimeException('"' . Runtime::AWAITING_NAME . '" is missing. Reset the module in Modules > Module Manager, or run php bin/console openreceive:configure.');
            }
            return '"' . Runtime::AWAITING_NAME . '" (id ' . $id . ') until a payment settles, then PrestaShop\'s "Payment accepted"';
        });
        $this->check('Payment option', static function (): string {
            $module = \Module::getInstanceByName(Runtime::MODULE);
            if (!$module instanceof \PaymentModule || !$module->isRegisteredInHook('paymentOptions')) {
                throw new \RuntimeException('not hooked into checkout. Reset the module in Modules > Module Manager.');
            }
            $currencies = array_map(static fn (array $row): string => (string) (new \Currency((int) $row['id_currency']))->iso_code, (array) $module->getCurrency((int) \Configuration::get('PS_CURRENCY_DEFAULT')));
            if ($currencies === []) {
                throw new \RuntimeException('no currency is allowed for it. Tick your currencies in Payment > Preferences.');
            }
            return '"' . Runtime::paymentName() . '"' . (Runtime::ready() ? '' : ' (hidden until a wallet code is saved)') . ', for carts in ' . implode(', ', array_unique($currencies));
        });
        $this->check('Tables', function (): string {
            $repository = Runtime::repository();
            $attention = $repository->connection()->query('SELECT reference FROM ' . Runtime::table() . ' WHERE status = ? ORDER BY id LIMIT 50', ['attention']);
            $this->lines[] = '  orders needing attention (first 50): ' . (implode(', ', array_column($attention, 'reference')) ?: 'none');
            return Runtime::table() . ' and ' . Runtime::metaTable();
        });
        $this->check('Checkout files', static function (): string {
            $assets = dirname(__DIR__, 2) . '/views/assets';
            if (!is_file($assets . '/openreceive-checkout.js') || !is_file($assets . '/openreceive-checkout.css')) {
                throw new \RuntimeException('missing from modules/openreceive/views/assets. Upload the whole release ZIP again.');
            }
            $manifest = json_decode((string) @file_get_contents($assets . '/MANIFEST.json'), true);
            return 'views/assets/openreceive-checkout.js, version ' . (is_array($manifest) ? ($manifest['version'] ?? 'unknown') : 'unknown');
        });
        $service = null;
        $this->check('Wallet preflight', static function () use (&$service, &$env): string {
            $service = Runtime::service($env);
            return 'passed (receive-only)';
        });
        if ($service instanceof Service) {
            $this->check('Price feed', static function () use ($service): string {
                $currencies = Runtime::currencies();
                $service->listRates(['currencies' => $currencies]);
                return 'available for ' . implode(', ', $currencies);
            });
            foreach ($service->swapProviders() as $provider) {
                $this->check('Swap provider ' . $provider->name(), static fn (): string => self::swapProviderStatus($provider));
            }
        } else {
            $this->lines[] = 'Price feed: not checked, because the wallet check failed';
        }
        $this->check('Reconcile', static function (): string {
            $rows = Runtime::connection()->query('SELECT value FROM ' . Runtime::metaTable() . ' WHERE `key` = ?', [MetaStore::RECONCILE_GATE_KEY]);
            $gate = json_decode((string) ($rows[0]['value'] ?? ''), true);
            $last = is_array($gate) ? (int) ($gate['finished_at'] ?? $gate['claimed_at'] ?? 0) : 0;
            $pending = (int) (Runtime::connection()->query('SELECT COUNT(*) AS n FROM ' . Runtime::table() . ' WHERE status = ?', ['pending'])[0]['n'] ?? 0);
            return 'on every checkout request, and from cron: php bin/console openreceive:reconcile every five minutes. Last wallet scan: '
                . ($last > 0 ? gmdate('Y-m-d H:i', $last) . ' UTC' : 'none yet') . "; {$pending} payment(s) pending";
        });

        foreach ($this->lines as $line) {
            $output->writeln($line);
        }
        $output->writeln($this->ok ? 'OpenReceive is ready.' : 'OpenReceive is not ready: fix each FAILED line above.');
        return $this->ok ? Command::SUCCESS : Command::FAILURE;
    }

    private function check(string $name, callable $probe): void
    {
        try {
            $this->lines[] = $name . ': ' . $probe();
        } catch (\Throwable $error) {
            $this->ok = false;
            $this->lines[] = $name . ': FAILED — ' . Runtime::errorMessage($error);
        }
    }

    /** A set code proves nothing about the provider, so ask it for the catalog checkout offers. */
    private static function swapProviderStatus(SwapProvider $provider): string
    {
        $catalog = $provider->payInAssetCatalog();
        $offered = array_filter($catalog, static fn (array $row): bool => ($row['available'] ?? true) !== false);
        if ($offered === []) {
            throw new \RuntimeException('answered with no available assets, so checkout offers no swaps through it.');
        }
        return sprintf('answered, %d of %d assets available', count($offered), count($catalog));
    }
}
