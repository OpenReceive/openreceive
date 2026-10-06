<?php
declare(strict_types=1);
namespace OpenReceive\WP;

final class Cli
{
    /**
     * Save encrypted credentials from stdin, then optionally enable checkout.
     *
     * ## OPTIONS
     *
     * [--nwc-uri=<source>]
     * : Use - to read a receive-only wallet code from stdin.
     * [--lsc-uri-primary=<source>]
     * : Use - to read the primary swap-provider code from stdin.
     * [--lsc-uri-backup=<source>]
     * : Use - to read the backup swap-provider code from stdin.
     * [--enable]
     * : Enable the gateway after successful preflight.
     */
    public function configure(array $args, array $options): void
    {
        $value = '';
        try {
            $fields = [];
            foreach (Secrets::FIELDS as $field => $_name) {
                $flag = str_replace('_', '-', $field);
                if (array_key_exists($flag, $options)) {
                    if ($options[$flag] !== '-') { throw new \InvalidArgumentException('Credential options accept only - (stdin). Never pass a code as a command argument.'); }
                    $fields[] = $field;
                }
            }
            if (count($fields) > 1) { throw new \InvalidArgumentException('Read one credential per invocation; save the wallet first, then each swap provider.'); }
            if ($fields === [] && !isset($options['enable'])) { throw new \InvalidArgumentException('Specify a credential option with - or --enable.'); }
            $settings = get_option('woocommerce_openreceive_settings', []);
            if ($fields !== []) {
                $value = (string) stream_get_contents(STDIN);
                $settings = Configuration::withSecret($settings, $fields[0], $value);
            }
            if (isset($options['enable'])) { $settings['enabled'] = 'yes'; }
            if (Secrets::environment($settings)['NWC_URI'] === '' && !(defined('OPENRECEIVE_DEMO_WALLET') && OPENRECEIVE_DEMO_WALLET === 'testkit')) { throw new \RuntimeException('Configure the receive-only wallet first with --nwc-uri=-.'); }
            Configuration::save($settings);
            \WP_CLI::success('Settings saved; wallet preflight passed.');
        } catch (\Throwable $error) {
            \WP_CLI::error(Configuration::errorMessage($error, [$value, trim($value)]));
        }
    }

    /** Report configuration health; exit nonzero when any required check fails. */
    public function doctor(): void
    {
        $report = Plugin::diagnosticReport();
        foreach ($report['lines'] as $line) { \WP_CLI::line($line); }
        \WP_CLI::line('Agent skills: run `npx skills add OpenReceive/openreceive` in your project');
        if (!$report['ok']) { \WP_CLI::halt(1); }
    }
}
