<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Commands;

use Box\Mod\Openreceive\Support\Runtime;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/** One reconcile pass now. FOSSBilling's cron runs one on every cron run already. */
#[AsCommand(name: 'openreceive:reconcile', description: 'Record OpenReceive payments whose buyer left the page (FOSSBilling\'s cron already runs this)')]
class Reconcile extends Command implements \FOSSBilling\InjectionAwareInterface
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

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
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
