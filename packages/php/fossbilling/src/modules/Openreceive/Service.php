<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive;

use Box\Mod\Openreceive\Support\GatewayFiles;
use Box\Mod\Openreceive\Support\Runtime;

/**
 * FOSSBilling calls install() each time the module is activated: it writes
 * the payment gateway into library/Payment/Adapter/OpenReceive, creates the
 * engine's tables and the payment gateway row, which stays disabled until a
 * wallet code is saved. Its hook runs a reconcile pass on every FOSSBilling
 * cron run, which finds a payment whose buyer closed the page before it
 * settled.
 */
class Service implements \FOSSBilling\InjectionAwareInterface
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

    /** Saving the codes is the module's one setting; FOSSBilling fills in its label. */
    public function getModulePermissions(): array
    {
        return ['manage_settings' => []];
    }

    public function install(): bool
    {
        // FOSSBilling creates a gateway row only for a gateway it finds in
        // library/Payment/Adapter, so the files go first.
        try {
            $found = GatewayFiles::install();
        } catch (\RuntimeException $error) {
            throw new \FOSSBilling\InformationException($error->getMessage());
        }
        if ($found === GatewayFiles::OUTDATED) {
            $this->di['logger']->setChannel('billing')->info('OpenReceive updated its payment gateway in library/Payment/Adapter/OpenReceive to version ' . Runtime::VERSION);
        }
        Runtime::migrate();
        Runtime::ensureGateway();
        Runtime::resumeGateway();
        return true;
    }

    /**
     * Uninstalling leaves the gateway off and keeps the payment records, the
     * gateway's row and its files in library/Payment/Adapter: FOSSBilling's
     * invoices and transactions refer to them.
     */
    public function uninstall(): bool
    {
        Runtime::pauseGateway();
        return true;
    }

    /**
     * A deactivated module serves no checkout routes, so its gateway stops
     * being offered first. Activating the module again offers it again.
     */
    public static function onBeforeAdminDeactivateExtension(\Box_Event $event): void
    {
        $di = $event->getDi();
        // The event names the extension's row id. Read the row itself: its
        // repository class only exists from FOSSBilling 0.8.5.
        $name = $di['dbal']->fetchOne("SELECT name FROM extension WHERE id = ? AND type = 'mod'", [(int) ($event->getParameters()['id'] ?? 0)]);
        if ($name === Runtime::MODULE) {
            Runtime::setDi($di);
            Runtime::pauseGateway();
        }
    }

    public static function onAfterAdminCronRun(\Box_Event $event): void
    {
        Runtime::setDi($event->getDi());
        try {
            Runtime::reconcile();
        } catch (\Throwable $error) {
            $event->getDi()['logger']->error('OpenReceive reconcile failed: ' . Runtime::errorMessage($error));
        }
    }
}
