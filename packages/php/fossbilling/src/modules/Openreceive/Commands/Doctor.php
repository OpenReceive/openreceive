<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Commands;

use Box\Mod\Openreceive\Support\GatewayFiles;
use Box\Mod\Openreceive\Support\Runtime;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Swap\SwapProvider;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * `php console.php openreceive:doctor` — the install state in one command:
 * the module, the PHP requirements, the payment gateway's files and row,
 * each code as set or unset (never its value), the tables, the checkout
 * files, the wallet, the price feed, each swap provider and the cron hook.
 * Exits 1 when a check fails.
 */
#[AsCommand(name: 'openreceive:doctor', description: 'Check OpenReceive\'s install: module, gateway, codes (set or unset only), tables, wallet, prices, swaps, cron')]
class Doctor extends Command implements \FOSSBilling\InjectionAwareInterface
{
    protected ?\Pimple\Container $di = null;

    /** @var list<string> */
    private array $lines = [];

    private bool $ok = true;

    public function setDi(\Pimple\Container $di): void
    {
        $this->di = $di;
        Runtime::setDi($di);
    }

    public function getDi(): ?\Pimple\Container
    {
        return $this->di;
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $di = $this->di;
        $this->check('Module', static function () use ($di): string {
            if (!$di['mod_service']('extension')->isExtensionActive('mod', Runtime::MODULE)) {
                throw new \RuntimeException('not active. Activate OpenReceive under Extensions in the admin area.');
            }
            return 'active, version ' . Runtime::VERSION;
        });
        $this->check('Requirements', static function (): string {
            $missing = array_keys(array_filter(['64-bit PHP' => PHP_INT_SIZE < 8, 'gmp' => !extension_loaded('gmp'), 'sodium' => !extension_loaded('sodium')]));
            if ($missing !== []) {
                throw new \RuntimeException('missing ' . implode(', ', $missing) . '. The web server\'s PHP and the command-line PHP both need them.');
            }
            return '64-bit PHP with GMP and sodium';
        });
        $env = null;
        $this->check('Codes', function () use (&$env): string {
            $env = Runtime::environment();
            foreach (Runtime::SECRET_KEYS as $name) {
                $this->lines[] = '  ' . $name . ': ' . ($env[$name] === '' ? 'unset' : 'set');
            }
            if ($env['NWC_URI'] === '') {
                throw new \RuntimeException('NWC_URI is not set. Save it under Extensions > OpenReceive, or pipe it in: php console.php openreceive:configure --nwc-uri=- < /path/to/code-file');
            }
            return 'readable';
        });
        $this->check('Payment gateway files', static function (): string {
            return match (GatewayFiles::status()) {
                GatewayFiles::CURRENT => 'library/Payment/Adapter/' . Runtime::GATEWAY . ', version ' . Runtime::VERSION,
                GatewayFiles::FOREIGN => throw new \RuntimeException('library/Payment/Adapter/' . Runtime::GATEWAY . '/OpenReceive.php is not OpenReceive\'s. Move that folder elsewhere, then run php modules/Openreceive/activate.php.'),
                default => throw new \RuntimeException('library/Payment/Adapter/' . Runtime::GATEWAY . ' is missing or from another version. Run php modules/Openreceive/activate.php, which writes it.'),
            };
        });
        $this->check('Payment gateway', static function (): string {
            $gateway = Runtime::gateway();
            if ($gateway === null) {
                throw new \RuntimeException('none. Activate the OpenReceive module, or run php console.php openreceive:configure.');
            }
            if (!$gateway->enabled) {
                throw new \RuntimeException("\"{$gateway->name}\" (id {$gateway->id}) is off, so invoices do not offer it. Saving a wallet code turns it on.");
            }
            return "\"{$gateway->name}\" (id {$gateway->id}), offered on unpaid invoices";
        });
        $this->check('Tables', function (): string {
            $repository = Runtime::repository();
            $attention = $repository->connection()->query('SELECT reference FROM ' . PaymentsSchema::DEFAULT_TABLE . ' WHERE status = ? ORDER BY id LIMIT 50', ['attention']);
            $this->lines[] = '  invoices needing attention (first 50): ' . (implode(', ', array_column($attention, 'reference')) ?: 'none');
            return 'schema ' . PaymentsSchema::SCHEMA_VERSION;
        });
        $this->check('Checkout files', static function (): string {
            $assets = dirname(__DIR__) . '/assets';
            $manifest = json_decode((string) @file_get_contents($assets . '/MANIFEST.json'), true);
            if (!is_file($assets . '/openreceive-checkout.js') || !is_file($assets . '/openreceive-checkout.css')) {
                throw new \RuntimeException('missing from modules/Openreceive/assets. Unzip the whole release again.');
            }
            return Runtime::ASSET_PREFIX . '/openreceive-checkout.js, version ' . ($manifest['version'] ?? 'unknown') . '; routes under ' . Runtime::PREFIX;
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
        $this->check('Reconcile', static function () use ($di): string {
            $hooked = $di['dbal']->fetchOne("SELECT id FROM extension_meta WHERE extension = 'mod_hook' AND rel_type = 'mod' AND rel_id = ? AND meta_key = 'listener' AND meta_value = 'onAfterAdminCronRun'", [Runtime::MODULE]);
            if (!$hooked) {
                throw new \RuntimeException('not hooked into FOSSBilling\'s cron. Deactivate and activate the OpenReceive module again.');
            }
            $last = $di['mod_service']('cron')->getLastExecutionTime();
            return 'on every FOSSBilling cron run (its last run: ' . ($last ?: 'never — is FOSSBilling\'s cron job running?') . ')';
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
