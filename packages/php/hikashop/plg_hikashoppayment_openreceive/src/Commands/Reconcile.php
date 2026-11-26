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
use Symfony\Component\Console\Output\OutputInterface;

\defined('_JEXEC') or die;

/**
 * One reconcile pass. Joomla and HikaShop run nothing between page views,
 * so the quickstart's cron line runs this every five minutes: it records the
 * payments whose customer left the page before they settled.
 */
final class Reconcile extends AbstractCommand
{
    /** @var string */
    protected static $defaultName = 'openreceive:reconcile';

    protected function configure(): void
    {
        $this->setDescription('Record OpenReceive payments whose customer left the page (run it from cron every five minutes)');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        try {
            Runtime::bootCli();
            Runtime::reconcile();
            Runtime::recordCronRun();
        } catch (\Throwable $error) {
            $output->writeln('<error>Reconcile failed: ' . Runtime::errorMessage($error) . '</error>');
            return 1;
        }
        $output->writeln('Reconcile pass done.');
        return 0;
    }
}
