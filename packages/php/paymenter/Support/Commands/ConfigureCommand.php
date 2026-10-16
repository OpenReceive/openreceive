<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support\Commands;

use Illuminate\Console\Command;
use OpenReceive\Server\Service;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Runtime;

/**
 * `php artisan openreceive:configure --nwc-uri=-` saves a code read from
 * stdin into the gateway's encrypted settings. A code never travels as a
 * command argument, where the shell history and the process list keep it.
 */
final class ConfigureCommand extends Command
{
    protected $signature = 'openreceive:configure
        {--nwc-uri= : Use - to read the receive-only wallet code from stdin}
        {--lsc-uri-primary= : Use - to read the swap provider code from stdin}
        {--name= : The payment method\'s name at checkout}';

    protected $description = 'Save OpenReceive\'s codes (read from stdin, stored encrypted) and create its tables';

    public function handle(): int
    {
        $flags = ['nwc-uri' => 'nwc_uri', 'lsc-uri-primary' => 'lsc_uri_primary'];
        $given = array_filter($flags, fn (string $flag): bool => $this->option($flag) !== null, ARRAY_FILTER_USE_KEY);
        foreach (array_keys($given) as $flag) {
            if ($this->option($flag) !== '-') {
                $this->error("--{$flag} accepts only - (stdin). Never pass a code as a command argument.");
                return self::FAILURE;
            }
        }
        if (count($given) > 1) {
            $this->error('Save one code per run: stdin holds one code.');
            return self::FAILURE;
        }
        $code = null;
        if ($given !== []) {
            $code = trim((string) stream_get_contents(STDIN));
            if ($code === '') {
                $this->error('stdin was empty. Pipe the code in, for example: printf \'%s\' "$CODE" | php artisan openreceive:configure --nwc-uri=-');
                return self::FAILURE;
            }
        }

        try {
            Runtime::migrate();
            $gateway = Runtime::ensureGateway();
            $key = array_values($given)[0] ?? null;
            if ($key === 'nwc_uri') {
                // The wallet must answer as a receive-only wallet before its code is saved.
                Service::fromEnvironment(['NWC_URI' => $code] + Runtime::environment($gateway), Runtime::currencies(), walletInfoCacheSeconds: 0);
            }
            if ($key !== null) {
                $gateway->settings()->updateOrCreate(['key' => $key], ['value' => $code, 'encrypted' => true, 'type' => 'string']);
            }
            $name = $this->option('name');
            if (is_string($name) && trim($name) !== '') {
                $gateway->update(['name' => trim($name)]);
            } elseif ($key === 'lsc_uri_primary' && $gateway->name === Runtime::DEFAULT_NAME) {
                $gateway->update(['name' => Runtime::SWAP_NAME]);
            }
        } catch (\Throwable $error) {
            $this->error('Nothing was saved: ' . Runtime::errorMessage($error));
            return self::FAILURE;
        }

        if ($key === 'nwc_uri') {
            $this->info('Saved the receive-only wallet code, encrypted. The wallet answered as receive-only.');
        } elseif ($key === 'lsc_uri_primary') {
            $this->info('Saved the swap provider code, encrypted.');
        }
        $this->info("Checkout offers \"{$gateway->fresh()?->name}\" on every unpaid invoice once a wallet code is saved. Check everything with: php artisan openreceive:doctor");
        return self::SUCCESS;
    }
}
