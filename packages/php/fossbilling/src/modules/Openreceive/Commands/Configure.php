<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Commands;

use Box\Mod\Openreceive\Support\Runtime;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * `php console.php openreceive:configure --nwc-uri=-` saves a code read from
 * stdin into the module's encrypted settings and turns the payment method
 * on. A code never travels as a command argument, where the shell history
 * and the process list keep it.
 */
#[AsCommand(name: 'openreceive:configure', description: 'Save OpenReceive\'s codes (read from stdin, stored encrypted), create its tables and turn the payment method on')]
class Configure extends Command implements \FOSSBilling\InjectionAwareInterface
{
    protected ?\Pimple\Container $di = null;

    public function setDi(\Pimple\Container $di): void
    {
        $this->di = $di;
        Runtime::setDi($di);
    }

    public function getDi(): ?\Pimple\Container
    {
        return $this->di;
    }

    protected function configure(): void
    {
        $this->addOption('nwc-uri', null, InputOption::VALUE_REQUIRED, 'Use - to read the receive-only wallet code from stdin');
        $this->addOption('lsc-uri-primary', null, InputOption::VALUE_REQUIRED, 'Use - to read the swap provider code from stdin');
        $this->addOption('name', null, InputOption::VALUE_REQUIRED, 'The payment method\'s name on invoices');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $flags = ['nwc-uri' => 'nwc_uri', 'lsc-uri-primary' => 'lsc_uri_primary'];
        $given = array_filter($flags, static fn (string $flag): bool => $input->getOption($flag) !== null, ARRAY_FILTER_USE_KEY);
        foreach (array_keys($given) as $flag) {
            if ($input->getOption($flag) !== '-') {
                $output->writeln("<error>--{$flag} accepts only - (stdin). Never pass a code as a command argument.</error>");
                return Command::FAILURE;
            }
        }
        if (count($given) > 1) {
            $output->writeln('<error>Save one code per run: stdin holds one code.</error>');
            return Command::FAILURE;
        }
        $codes = [];
        if ($given !== []) {
            $code = trim((string) stream_get_contents(STDIN));
            if ($code === '') {
                $output->writeln('<error>stdin was empty. Pipe the code in, for example: php console.php openreceive:configure --nwc-uri=- < /path/to/code-file</error>');
                return Command::FAILURE;
            }
            $codes[array_values($given)[0]] = $code;
        }

        try {
            $gateway = Runtime::saveCodes($codes, is_string($input->getOption('name')) ? $input->getOption('name') : null);
        } catch (\Throwable $error) {
            $output->writeln('<error>Nothing was saved: ' . Runtime::errorMessage($error) . '</error>');
            return Command::FAILURE;
        }

        if (isset($codes['nwc_uri'])) {
            $output->writeln('<info>Saved the receive-only wallet code, encrypted. The wallet answered as receive-only.</info>');
        } elseif (isset($codes['lsc_uri_primary'])) {
            $output->writeln('<info>Saved the swap provider code, encrypted.</info>');
        }
        $output->writeln($gateway->enabled
            ? "Unpaid invoices offer \"{$gateway->name}\". Check everything with: php console.php openreceive:doctor"
            : "The payment method \"{$gateway->name}\" stays off until a wallet code is saved: php console.php openreceive:configure --nwc-uri=- < /path/to/code-file");
        return Command::SUCCESS;
    }
}
