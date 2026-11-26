<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop\Commands;

use Joomla\Console\Command\AbstractCommand;
use OpenReceiveHikaShop\Runtime;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

\defined('_JEXEC') or die;

/**
 * `php cli/joomla.php openreceive:configure --nwc-uri=-` saves a code read
 * from stdin into the plugin's settings, sealed with the site's secret, and
 * makes the HikaShop payment method customers pick. A code never travels as
 * a command argument, where the shell history and the process list keep it.
 */
final class Configure extends AbstractCommand
{
    /** @var string */
    protected static $defaultName = 'openreceive:configure';

    protected function configure(): void
    {
        $this->setDescription('Save OpenReceive\'s codes (read from stdin, stored encrypted), create its tables and its HikaShop payment method');
        $this->addOption('nwc-uri', null, InputOption::VALUE_REQUIRED, 'Use - to read the receive-only wallet code from stdin');
        $this->addOption('lsc-uri-primary', null, InputOption::VALUE_REQUIRED, 'Use - to read the swap provider code from stdin');
        $this->addOption('name', null, InputOption::VALUE_REQUIRED, 'The payment method\'s name at checkout');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        Runtime::bootCli();
        $flags = ['nwc-uri' => 'nwc_uri', 'lsc-uri-primary' => 'lsc_uri_primary'];
        $given = array_filter($flags, static fn (string $flag): bool => $input->getOption($flag) !== null, ARRAY_FILTER_USE_KEY);
        foreach (array_keys($given) as $flag) {
            if ($input->getOption($flag) !== '-') {
                $output->writeln("<error>--{$flag} accepts only - (stdin). Never pass a code as a command argument.</error>");
                return 1;
            }
        }
        if (count($given) > 1) {
            $output->writeln('<error>Save one code per run: stdin holds one code.</error>');
            return 1;
        }
        $codes = [];
        if ($given !== []) {
            $code = trim((string) stream_get_contents(STDIN));
            if ($code === '') {
                $output->writeln('<error>stdin was empty. Pipe the code in, for example: php cli/joomla.php openreceive:configure --nwc-uri=- < /path/to/code-file</error>');
                return 1;
            }
            $codes[array_values($given)[0]] = $code;
        }

        try {
            Runtime::saveCodes($codes);
            $name = is_string($input->getOption('name')) ? $input->getOption('name') : null;
            $id = Runtime::ensurePaymentMethod($name);
        } catch (\Throwable $error) {
            $output->writeln('<error>Nothing was saved: ' . Runtime::errorMessage($error) . '</error>');
            return 1;
        }

        if (isset($codes['nwc_uri'])) {
            $output->writeln('<info>Saved the receive-only wallet code, encrypted. The wallet answered as receive-only.</info>');
        } elseif (isset($codes['lsc_uri_primary'])) {
            $output->writeln('<info>Saved the swap provider code, encrypted.</info>');
        }
        $method = array_values(array_filter(Runtime::paymentMethods(), static fn (array $row): bool => $row['payment_id'] === $id))[0] ?? null;
        $label = $method === null ? Runtime::DEFAULT_NAME : $method['payment_name'];
        $output->writeln(Runtime::ready()
            ? "Checkout offers \"{$label}\" (HikaShop payment method {$id}). Check everything with: php cli/joomla.php openreceive:doctor"
            : "The payment method \"{$label}\" stays hidden until a wallet code is saved: php cli/joomla.php openreceive:configure --nwc-uri=- < /path/to/code-file");
        return 0;
    }
}
