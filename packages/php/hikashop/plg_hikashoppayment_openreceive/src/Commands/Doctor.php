<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop\Commands;

use Joomla\Console\Command\AbstractCommand;
use OpenReceive\Server\Doctor as CoreDoctor;
use OpenReceive\Server\Service;
use OpenReceive\Storage\MetaStore;
use OpenReceive\Swap\SwapProvider;
use OpenReceiveHikaShop\CronStatus;
use OpenReceiveHikaShop\Requirements;
use OpenReceiveHikaShop\Runtime;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

\defined('_JEXEC') or die;

/**
 * `php cli/joomla.php openreceive:doctor` — the install state in one
 * command: the plugins, the PHP requirements, HikaShop, each code as set or
 * unset (never its value), the payment method, the tables, the checkout
 * files, the wallet, the price feed, each swap provider and the last
 * reconcile pass. Exits 1 when a check fails.
 */
final class Doctor extends AbstractCommand
{
    /** @var string */
    protected static $defaultName = 'openreceive:doctor';

    /** @var list<string> */
    private array $lines = [];

    private bool $ok = true;

    protected function configure(): void
    {
        $this->setDescription('Check OpenReceive\'s install: plugins, HikaShop, codes (set or unset only), payment method, tables, wallet, prices, swaps, reconcile');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        $this->lines = [];
        $this->ok = true;
        $this->check('HikaShop', static function (): string {
            Runtime::bootCli();
            $rows = Runtime::connection()->query('SELECT enabled, manifest_cache FROM ' . Runtime::prefix() . 'extensions WHERE type = ? AND element = ?', ['component', 'com_hikashop']);
            if ($rows === [] || (int) $rows[0]['enabled'] !== 1) {
                throw new \RuntimeException('not installed or disabled. Install HikaShop (the free Starter edition is enough).');
            }
            $manifest = json_decode((string) $rows[0]['manifest_cache'], true);
            return 'installed, version ' . (is_array($manifest) ? ($manifest['version'] ?? 'unknown') : 'unknown');
        });
        $this->check('Plugin', static function (): string {
            $rows = Runtime::connection()->query('SELECT enabled FROM ' . Runtime::prefix() . 'extensions WHERE type = ? AND folder = ? AND element = ?', ['plugin', Runtime::GROUP, Runtime::PLUGIN]);
            if ($rows === []) {
                throw new \RuntimeException('the HikaShop payment plugin is not installed. Install pkg_openreceive in System > Install > Extensions.');
            }
            if ((int) $rows[0]['enabled'] !== 1) {
                throw new \RuntimeException('"HikaShop Payment - OpenReceive" is disabled. Enable it in System > Manage > Plugins.');
            }
            return 'HikaShop Payment - OpenReceive enabled, version ' . Runtime::VERSION;
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
                throw new \RuntimeException('NWC_URI is not set. Save it on the payment method\'s page in HikaShop, or pipe it in: php cli/joomla.php openreceive:configure --nwc-uri=- < /path/to/code-file');
            }
            return 'readable';
        });
        $this->check('Payment method', static function (): string {
            $published = array_values(array_filter(Runtime::paymentMethods(), static fn (array $row): bool => $row['payment_published'] === 1));
            if ($published === []) {
                throw new \RuntimeException('no published HikaShop payment method uses OpenReceive. Make one in HikaShop > System > Payment methods, or run php cli/joomla.php openreceive:configure.');
            }
            $names = array_map(static fn (array $row): string => '"' . $row['payment_name'] . '" (id ' . $row['payment_id'] . ')', $published);
            return implode(', ', $names) . (Runtime::ready() ? '' : ', hidden at checkout until a wallet code is saved')
                . '; unpaid orders wait in ' . implode(', ', Runtime::unpaidStatuses()) . ', for carts in ' . implode(', ', Runtime::currencies());
        });
        $this->check('Tables', function (): string {
            $repository = Runtime::repository();
            $attention = $repository->connection()->query('SELECT reference FROM ' . Runtime::table() . ' WHERE status = ? ORDER BY id LIMIT 50', ['attention']);
            $this->lines[] = '  orders needing attention (first 50): ' . (implode(', ', array_column($attention, 'reference')) ?: 'none');
            return Runtime::table() . ' and ' . Runtime::metaTable();
        });
        $this->check('Checkout files', static function (): string {
            $assets = JPATH_ROOT . '/' . Runtime::MEDIA;
            if (!is_file($assets . '/openreceive-checkout.js') || !is_file($assets . '/openreceive-checkout.css')) {
                throw new \RuntimeException('missing from ' . Runtime::MEDIA . '. Install the whole OpenReceive package again.');
            }
            $manifest = json_decode((string) @file_get_contents($assets . '/MANIFEST.json'), true);
            return Runtime::MEDIA . '/openreceive-checkout.js, version ' . (is_array($manifest) ? ($manifest['version'] ?? 'unknown') : 'unknown');
        });
        $service = null;
        $this->check('Wallet preflight', static function () use (&$service, &$env): string {
            if (!is_array($env)) {
                throw new \RuntimeException('not checked, because the codes could not be read');
            }
            $service = Runtime::service($env);
            CoreDoctor::proveCodeAccepted($service->nwcClient());
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
            return 'on every checkout request, and from cron: php cli/joomla.php openreceive:reconcile every five minutes. Last wallet scan: '
                . ($last > 0 ? gmdate('Y-m-d H:i', $last) . ' UTC' : 'none yet') . "; {$pending} payment(s) pending"
                . '. Last cron run: ' . CronStatus::describe(Runtime::lastCronRun(), time());
        });

        foreach ($this->lines as $line) {
            $output->writeln($line);
        }
        $output->writeln($this->ok ? 'OpenReceive is ready.' : 'OpenReceive is not ready: fix each FAILED line above.');
        return $this->ok ? 0 : 1;
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
