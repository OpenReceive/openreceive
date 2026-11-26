<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

use Joomla\CMS\Plugin\CMSPlugin;
use Joomla\Event\SubscriberInterface;

defined('_JEXEC') or die;

/**
 * OpenReceive's commands for Joomla's console (php cli/joomla.php):
 * openreceive:configure, openreceive:doctor, openreceive:test-invoice and
 * openreceive:reconcile. Their code ships in the HikaShop payment plugin.
 */
class PlgConsoleOpenreceive extends CMSPlugin implements SubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return ['application.before_execute' => 'registerCommands'];
    }

    public function registerCommands($event): void
    {
        $app = $event->getApplication();
        $autoload = JPATH_PLUGINS . '/hikashoppayment/openreceive/autoload.php';
        if (!method_exists($app, 'addCommand') || !is_file($autoload)) {
            return;
        }
        require_once $autoload;
        $app->addCommand(new \OpenReceiveHikaShop\Commands\Configure());
        $app->addCommand(new \OpenReceiveHikaShop\Commands\Doctor());
        $app->addCommand(new \OpenReceiveHikaShop\Commands\TestInvoice());
        $app->addCommand(new \OpenReceiveHikaShop\Commands\Reconcile());
    }
}
