<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop\Commands;

use Joomla\CMS\Uri\Uri;
use Joomla\Console\Command\AbstractCommand;
use OpenReceiveHikaShop\Endpoint;
use OpenReceiveHikaShop\Host;
use OpenReceiveHikaShop\Runtime;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

\defined('_JEXEC') or die;

/**
 * `php cli/joomla.php openreceive:test-invoice <order id>` — makes a
 * Lightning invoice for an unpaid OpenReceive order, through the same route
 * its thank-you page uses. `--new` first places a small test order, for a
 * test customer the command makes once (openreceive-test@example.invalid),
 * with one line and no product, so no real customer or stock is touched.
 */
final class TestInvoice extends AbstractCommand
{
    public const TEST_CUSTOMER = 'openreceive-test@example.invalid';

    /** @var string */
    protected static $defaultName = 'openreceive:test-invoice';

    protected function configure(): void
    {
        $this->setDescription('Make a Lightning invoice for an unpaid OpenReceive order, through the checkout\'s own route');
        $this->addArgument('order', InputArgument::OPTIONAL, 'The id of an unpaid OpenReceive order');
        $this->addOption('new', null, InputOption::VALUE_NONE, 'Place a small test order first');
        $this->addOption('amount', null, InputOption::VALUE_REQUIRED, 'The test order\'s amount, with --new', '5.00');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        Runtime::bootCli();
        if ($input->getOption('new')) {
            try {
                $orderId = $this->placeTestOrder((string) $input->getOption('amount'), $output);
            } catch (\Throwable $error) {
                $output->writeln('<error>The test order was not placed: ' . Runtime::errorMessage($error) . '</error>');
                return 1;
            }
            if ($orderId === null) {
                return 1;
            }
        } else {
            $id = (string) $input->getArgument('order');
            $order = Host::order($id);
            if ($order === null || !Host::unpaid($order)) {
                $output->writeln("<error>Order {$id} is not an unpaid OpenReceive order. Pass such an order's id, or --new to place a test order.</error>");
                return 1;
            }
            $orderId = $order['order_id'];
        }

        $answer = Endpoint::handle('POST', '/checkouts', ['Content-Type' => 'application/json'], (string) json_encode(['reference' => (string) $orderId]), ['REMOTE_ADDR' => '127.0.0.1']);
        $body = json_decode($answer['body'], true) ?: [];
        if ($answer['status'] !== 201) {
            $output->writeln(sprintf('<error>%s (HTTP %d, request_id %s)</error>', $body['message'] ?? 'Checkout failed.', $answer['status'], $body['request_id'] ?? 'none'));
            return 1;
        }
        $checkout = $body['checkout'];
        $output->writeln('Invoice: ' . $checkout['bolt11']);
        $output->writeln('Payment hash: ' . $checkout['payment_hash']);
        $output->writeln('Order page (it shows the checkout for this same invoice): ' . self::orderUrl($orderId));
        $methods = array_filter($body['payment_methods'] ?? [], 'is_array');
        if ($methods === []) {
            $output->writeln('Checkout methods: Bitcoin Lightning only (no swap provider configured).');
        } else {
            $output->writeln('Checkout methods on the order page:');
            $output->writeln('  Bitcoin Lightning: available');
            foreach ($methods as $method) {
                $output->writeln(sprintf('  %s on %s: %s', $method['label'] ?? '?', $method['network_label'] ?? '?',
                    ($method['available'] ?? false) ? 'available' : 'unavailable — ' . ($method['unavailable_message'] ?? $method['unavailable_reason'] ?? 'no reason given')));
            }
        }
        $order = Host::order((string) $orderId);
        $amount = (new Host())->amountFor((string) $orderId);
        $output->writeln(sprintf('<info>Order %s: %s sats for %s %s, expires %s UTC.</info>', $order['order_number'] ?? $orderId, number_format(intdiv((int) $checkout['amount_msats'], 1000)), $amount['value'] ?? '?', $amount['currency'] ?? '', gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
        return 0;
    }

    /** HikaShop's thank-you page for the order; its token lets any browser open it. */
    private static function orderUrl(int $orderId): string
    {
        $rows = Runtime::connection()->query('SELECT order_token FROM ' . Runtime::prefix() . 'hikashop_order WHERE order_id = ?', [$orderId]);
        return rtrim(Uri::root(), '/') . '/index.php?option=com_hikashop&ctrl=checkout&task=after_end&order_id=' . $orderId
            . '&order_token=' . rawurlencode((string) ($rows[0]['order_token'] ?? ''));
    }

    private function placeTestOrder(string $amount, OutputInterface $output): ?int
    {
        if (!preg_match('/\A[0-9]{1,9}(\.[0-9]{1,2})?\z/', $amount) || (float) $amount <= 0) {
            $output->writeln('<error>--amount must be a positive amount such as 5.00.</error>');
            return null;
        }
        if (!Runtime::ready()) {
            $output->writeln('<error>Save the wallet code first: php cli/joomla.php openreceive:configure --nwc-uri=- < /path/to/code-file</error>');
            return null;
        }
        $methods = array_values(array_filter(Runtime::paymentMethods(), static fn (array $row): bool => $row['payment_published'] === 1));
        if ($methods === []) {
            $output->writeln('<error>No published HikaShop payment method uses OpenReceive. Run php cli/joomla.php openreceive:configure first.</error>');
            return null;
        }
        $config = hikashop_config();
        $currencyId = (int) $config->get('main_currency', 1);
        $currency = Host::currency($currencyId);

        $product = new \stdClass();
        $product->product_id = 0;
        $product->order_product_name = 'OpenReceive test payment';
        $product->order_product_code = 'OPENRECEIVE-TEST';
        $product->order_product_quantity = 1;
        $product->order_product_price = $amount;
        $product->order_product_tax = 0;
        $product->order_product_options = '';
        $product->order_product_weight = 0;
        $product->order_product_weight_unit = 'kg';
        $product->order_product_dimension_unit = 'm';
        $product->cart_product_id = 0;

        $order = new \stdClass();
        $order->order_user_id = self::testCustomer();
        $order->order_status = (string) $config->get('order_created_status', 'created');
        $order->order_type = 'sale';
        $order->order_currency_id = $currencyId;
        $order->order_full_price = $amount;
        $order->order_payment_method = Runtime::PLUGIN;
        $order->order_payment_id = $methods[0]['payment_id'];
        $order->cart = new \stdClass();
        $order->cart->products = [$product];

        $orderClass = hikashop_get('class.order');
        $id = (int) $orderClass->save($order);
        if ($id <= 0) {
            throw new \RuntimeException('HikaShop did not save the test order.');
        }
        $saved = Host::order((string) $id);
        $output->writeln(sprintf('Placed test order %s (id %d) for %s %s, bought by %s. Cancel it in HikaShop > Orders when you are done; HikaShop keeps every order.', $saved['order_number'] ?? $id, $id, $amount, $currency['code'] ?? '', self::TEST_CUSTOMER));
        return $id;
    }

    /** A HikaShop customer only for test orders, made once, with no Joomla account: nobody can sign in as it. */
    private static function testCustomer(): int
    {
        $rows = Runtime::connection()->query('SELECT user_id FROM ' . Runtime::prefix() . 'hikashop_user WHERE user_email = ? AND user_cms_id = 0', [self::TEST_CUSTOMER]);
        if ($rows !== []) {
            return (int) $rows[0]['user_id'];
        }
        $user = new \stdClass();
        $user->user_email = self::TEST_CUSTOMER;
        $user->user_cms_id = 0;
        $id = (int) hikashop_get('class.user')->save($user);
        if ($id <= 0) {
            throw new \RuntimeException('HikaShop did not save the test customer.');
        }
        return $id;
    }
}
