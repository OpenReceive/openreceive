<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive\Commands;

use PrestaShop\Module\OpenReceive\Runtime;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * One reconcile pass. PrestaShop has no scheduler of its own, so the
 * quickstart's cron line runs this every five minutes: it records the
 * payments whose customer left the page before they settled.
 */
#[AsCommand(name: 'openreceive:reconcile', description: 'Record OpenReceive payments whose customer left the page (run it from cron every five minutes)')]
final class Reconcile extends Command
{
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        Runtime::cliContext();
        try {
            Runtime::reconcile();
        } catch (\Throwable $error) {
            $output->writeln('<error>Reconcile failed: ' . Runtime::errorMessage($error) . '</error>');
            return Command::FAILURE;
        }
        $output->writeln('Reconcile pass done.');
        return Command::SUCCESS;
    }
}
