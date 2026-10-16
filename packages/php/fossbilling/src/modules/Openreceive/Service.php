<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive;

use Box\Mod\Openreceive\Support\Runtime;

/**
 * FOSSBilling calls install() when the module is activated: it creates the
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
        Runtime::migrate();
        Runtime::ensureGateway();
        return true;
    }

    /** Uninstalling keeps the payment records: they are the shop's accounts. */
    public function uninstall(): bool
    {
        return true;
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
