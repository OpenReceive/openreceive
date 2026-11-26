<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

use Joomla\CMS\Factory;
use OpenReceiveHikaShop\CronStatus;
use OpenReceiveHikaShop\Endpoint;
use OpenReceiveHikaShop\Host;
use OpenReceiveHikaShop\Runtime;

defined('_JEXEC') or die;

if (!class_exists('hikashopPaymentPlugin')) {
    // Joomla loads every plugin of a group it imports; only HikaShop's pages
    // import this group, after loading their helpers.
    return;
}

require_once __DIR__ . '/autoload.php';

/**
 * OpenReceive's HikaShop payment plugin. The customer picks the payment
 * method at checkout; HikaShop creates the order unpaid and shows the
 * checkout on its thank-you page, and on the order's page in the customer's
 * account. A settled payment is written on the order's history and moves
 * the order to the method's paid status ("confirmed" by default).
 */
class plgHikashoppaymentOpenreceive extends hikashopPaymentPlugin
{
    public $name = 'openreceive';

    public $multiple = true;

    public $pluginConfig = [
        'nwc_uri' => ['Receive-only NWC code', 'openreceive_code'],
        'lsc_uri_primary' => ['Swap provider code (optional)', 'openreceive_code'],
        'verified_status' => ['VERIFIED_STATUS', 'orderstatus', 'confirmed'],
        'openreceive_status' => ['OpenReceive', 'openreceive_status'],
    ];

    /** Checkout offers the method only once a wallet code is saved. */
    public function onPaymentDisplay(&$order, &$methods, &$usable_methods)
    {
        if (!Runtime::ready()) {
            return true;
        }
        return parent::onPaymentDisplay($order, $methods, $usable_methods);
    }

    /**
     * "Finish" at checkout: HikaShop made the order, unpaid, in its created
     * status. The cart is emptied; the checkout itself is on the thank-you
     * page HikaShop goes to next (getThankYouContent).
     */
    public function onAfterOrderConfirm(&$order, &$methods, $method_id)
    {
        parent::onAfterOrderConfirm($order, $methods, $method_id);
        $this->removeCart = true;
        $html = $this->checkoutFor((int) $order->order_id);
        if ($html !== '') {
            echo $html;
        }
        return true;
    }

    /**
     * HikaShop's thank-you page, which it shows only to the order's customer
     * or a browser holding the order's token: the checkout, for an unpaid
     * order of this plugin.
     */
    public function getThankYouContent(&$order)
    {
        $html = $this->checkoutFor((int) @$order->order_id);
        if ($html === '') {
            return '';
        }
        return [
            'html' => $this->thankYouSection('', $html),
            'awaiting_payment' => true,
        ];
    }

    /** The order's page in the customer's account, which HikaShop shows only to its customer. */
    public function onAfterOrderProductsListingDisplay(&$order, $type)
    {
        if ($type !== 'order_front_show' || empty($order->order_id) || @$order->order_payment_method !== $this->name) {
            return;
        }
        echo $this->checkoutFor((int) $order->order_id);
    }

    /**
     * The checkout's routes: index.php?option=com_hikashop&ctrl=checkout
     * &task=notify&notif_payment=openreceive&path=/checkouts and the rest.
     * Every answer is the engine's JSON.
     */
    public function onPaymentNotification(&$statuses)
    {
        $headers = function_exists('getallheaders') ? (getallheaders() ?: []) : [];
        $answer = Endpoint::handle(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            (string) hikaInput::get()->getString('path', ''),
            $headers,
            (string) file_get_contents('php://input'),
            $_SERVER,
        );
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        http_response_code($answer['status']);
        foreach ($answer['headers'] as $name => $values) {
            header($name . ': ' . implode(', ', $values));
        }
        echo $answer['body'];
        Factory::getApplication()->close();
    }

    /** The payment method's settings page in HikaShop's back office. */
    public function onPaymentConfiguration(&$element)
    {
        parent::onPaymentConfiguration($element);
        if (!Runtime::ready()) {
            Factory::getApplication()->enqueueMessage('Paste your receive-only NWC code and save: checkout offers this payment method once the wallet answered as receive-only.', 'warning');
            return;
        }
        $cron = CronStatus::warning(Runtime::lastCronRun(), time(), JPATH_ROOT . '/cli/joomla.php');
        if ($cron !== null) {
            Factory::getApplication()->enqueueMessage(htmlspecialchars($cron, ENT_QUOTES), 'warning');
        }
    }

    /**
     * Saves a pasted code, sealed, in the plugin's own settings, never in
     * the payment method's: every OpenReceive payment method uses the same
     * wallet. A blank field keeps the saved code.
     */
    public function onPaymentConfigurationSave(&$element)
    {
        $params = $element->payment_params ?? null;
        if (!is_object($params)) {
            return true;
        }
        $codes = [];
        foreach (array_keys(Runtime::SECRET_KEYS) as $key) {
            $codes[$key] = trim((string) ($params->$key ?? ''));
            unset($params->$key);
        }
        unset($params->openreceive_status);
        if (array_filter($codes) === []) {
            return true;
        }
        try {
            Runtime::saveCodes($codes);
            Factory::getApplication()->enqueueMessage('Saved. A wallet code is saved only after the wallet answered as receive-only.', 'message');
        } catch (\Throwable $error) {
            Factory::getApplication()->enqueueMessage('The code was not saved: ' . htmlspecialchars(Runtime::errorMessage($error), ENT_QUOTES), 'error');
        }
        return true;
    }

    /** The two settings HikaShop's form cannot draw: a code field that never shows the code, and the status line. */
    public function pluginConfigDisplay($fieldType, $data, $type, $paramsType, $key, $element)
    {
        $e = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        if ($fieldType === 'openreceive_code') {
            try {
                $set = Runtime::codes()[$key] !== '';
            } catch (\Throwable) {
                $set = false;
            }
            $hint = $key === 'nwc_uri'
                ? 'nostr+walletconnect://… from your wallet, receive-only.'
                : 'lightning+swapconnect://… to also accept USDT, USDC, SOL and ETH.';
            return '<input type="password" class="form-control" autocomplete="off" name="data[' . $e($type) . '][' . $e($paramsType) . '][' . $e($key) . ']" value=""'
                . ' placeholder="' . $e($set ? 'Saved. Paste a new code to replace it.' : 'Not set.') . '"/>'
                . '<p class="hika_description">' . $e($hint . ' Stored encrypted and never shown again.') . '</p>';
        }
        if ($fieldType === 'openreceive_status') {
            return '<p>' . $e('Check everything from the site\'s folder, as the web server\'s user: php cli/joomla.php openreceive:doctor') . '</p>';
        }
        return '';
    }

    public function getPaymentDefaultValues(&$element)
    {
        $element->payment_name = Runtime::DEFAULT_NAME;
        $element->payment_description = Runtime::methodsLine() . ' You pay on the next page, after placing the order.';
        $element->payment_images = '';
        $element->payment_params->verified_status = 'confirmed';
    }

    /** The status a paid order moves to: the payment method's setting, else HikaShop's confirmed status. */
    public function paidStatus(int $paymentId): string
    {
        if ($paymentId > 0 && $this->pluginParams($paymentId) && !empty($this->plugin_params->verified_status)) {
            return (string) $this->plugin_params->verified_status;
        }
        return (string) hikashop_config()->get('order_confirmed_status', 'confirmed');
    }

    /** Moves a paid order on, through HikaShop's order class: its invoice, emails and hooks. */
    public function markPaid(int $orderId, string $status, string $paymentHash): void
    {
        $this->payment_params = (object) ['verified_status' => $status];
        $history = new stdClass();
        $history->notified = 1;
        $history->data = 'OpenReceive payment hash ' . $paymentHash;
        $id = $orderId;
        $this->modifyOrder($id, $status, $history, false);
    }

    /** The checkout for an unpaid order of this plugin; a short line once it is paid. */
    private function checkoutFor(int $orderId): string
    {
        $order = $orderId > 0 ? Host::order((string) $orderId) : null;
        if ($order === null) {
            return '';
        }
        if (Host::unpaid($order)) {
            return Runtime::checkoutHtml($order['order_id']);
        }
        return '';
    }
}
