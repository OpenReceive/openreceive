<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive\Commands;

use PrestaShop\Module\OpenReceive\Endpoint;
use PrestaShop\Module\OpenReceive\Host;
use PrestaShop\Module\OpenReceive\Runtime;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * `php bin/console openreceive:test-invoice <order id>` — makes a Lightning
 * invoice for an order awaiting its OpenReceive payment, through the same
 * route its order confirmation page uses. `--new` first places a small test
 * order: a hidden virtual product, bought by a test customer the command
 * creates once (openreceive-test@example.invalid), so no real customer sees
 * it.
 */
#[AsCommand(name: 'openreceive:test-invoice', description: 'Make a Lightning invoice for an order awaiting its OpenReceive payment, through the checkout\'s own route')]
final class TestInvoice extends Command
{
    public const TEST_CUSTOMER = 'openreceive-test@example.invalid';

    public const TEST_PRODUCT = 'OPENRECEIVE-TEST';

    protected function configure(): void
    {
        $this->addArgument('order', InputArgument::OPTIONAL, 'The id of an order awaiting its OpenReceive payment');
        $this->addOption('new', null, InputOption::VALUE_NONE, 'Place a small test order first');
        $this->addOption('amount', null, InputOption::VALUE_REQUIRED, 'The test order\'s amount, with --new', '5.00');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        Runtime::cliContext();
        if ($input->getOption('new')) {
            try {
                $order = $this->placeTestOrder((string) $input->getOption('amount'), $output);
            } catch (\Throwable $error) {
                $output->writeln('<error>The test order was not placed: ' . Runtime::errorMessage($error) . '</error>');
                return Command::FAILURE;
            }
            if ($order === null) {
                return Command::FAILURE;
            }
        } else {
            $id = (string) $input->getArgument('order');
            $order = Host::order($id);
            if ($order === null || (int) $order->current_state !== Runtime::awaitingState()) {
                $output->writeln("<error>Order {$id} is not an order awaiting its OpenReceive payment. Pass such an order's id, or --new to place a test order.</error>");
                return Command::FAILURE;
            }
            $primary = Host::primaryId($order);
            $order = $primary === (int) $order->id ? $order : new \Order($primary);
        }

        $answer = Endpoint::handle('POST', '/checkouts', ['Content-Type' => 'application/json'], (string) json_encode(['reference' => (string) $order->id]), ['REMOTE_ADDR' => '127.0.0.1']);
        $body = json_decode($answer['body'], true) ?: [];
        if ($answer['status'] !== 201) {
            $output->writeln(sprintf('<error>%s (HTTP %d, request_id %s)</error>', $body['message'] ?? 'Checkout failed.', $answer['status'], $body['request_id'] ?? 'none'));
            return Command::FAILURE;
        }
        $checkout = $body['checkout'];
        $output->writeln('Invoice: ' . $checkout['bolt11']);
        $output->writeln('Payment hash: ' . $checkout['payment_hash']);
        $output->writeln('Order page (it shows the checkout for this same invoice): ' . self::confirmationUrl($order));
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
        $amount = (new Host())->amountFor((string) $order->id);
        $output->writeln(sprintf('<info>Order %s: %s sats for %s %s, expires %s UTC.</info>', $order->reference, number_format(intdiv((int) $checkout['amount_msats'], 1000)), $amount['value'] ?? '?', $amount['currency'] ?? '', gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
        return Command::SUCCESS;
    }

    /** The order confirmation page; its secure key lets any browser open it. */
    private static function confirmationUrl(\Order $order): string
    {
        return \Context::getContext()->link->getPageLink('order-confirmation', null, (int) $order->id_lang, [
            'id_cart' => (int) $order->id_cart,
            'id_module' => (int) \Module::getModuleIdByName(Runtime::MODULE),
            'id_order' => (int) $order->id,
            'key' => (string) $order->secure_key,
        ]);
    }

    private function placeTestOrder(string $amount, OutputInterface $output): ?\Order
    {
        if (!preg_match('/\A[0-9]{1,9}(\.[0-9]{1,2})?\z/', $amount) || (float) $amount <= 0) {
            $output->writeln('<error>--amount must be a positive amount such as 5.00.</error>');
            return null;
        }
        if (!Runtime::ready()) {
            $output->writeln('<error>Save the wallet code first: php bin/console openreceive:configure --nwc-uri=- < /path/to/code-file</error>');
            return null;
        }
        $context = \Context::getContext();
        $customer = self::testCustomer();
        $address = self::testAddress($customer);
        $product = self::testProduct($amount);

        $cart = new \Cart();
        $cart->id_customer = (int) $customer->id;
        $cart->id_address_delivery = (int) $address->id;
        $cart->id_address_invoice = (int) $address->id;
        $cart->id_currency = (int) $context->currency->id;
        $cart->id_lang = (int) $context->language->id;
        $cart->id_shop = (int) $context->shop->id;
        $cart->id_shop_group = (int) $context->shop->id_shop_group;
        $cart->secure_key = (string) $customer->secure_key;
        if (!$cart->add() || !$cart->updateQty(1, (int) $product->id)) {
            throw new \RuntimeException('PrestaShop did not make the test cart.');
        }
        $context->cart = $cart;
        $context->customer = $customer;

        $module = \Module::getInstanceByName(Runtime::MODULE);
        if (!$module instanceof \PaymentModule) {
            throw new \RuntimeException('The OpenReceive module is not installed.');
        }
        $module->validateOrder((int) $cart->id, Runtime::awaitingState(), (float) $cart->getOrderTotal(true, \Cart::BOTH), Runtime::paymentName(), null, [], (int) $cart->id_currency, false, (string) $customer->secure_key);
        $order = new \Order((int) $module->currentOrder);
        $output->writeln(sprintf('Placed test order %s (id %d) for %s %s, bought by %s. Cancel it in Orders when you are done; PrestaShop keeps every order.', $order->reference, $order->id, $amount, $context->currency->iso_code, $customer->email));
        return $order;
    }

    /** A customer only for test orders, made once. It never signs in: its password is random and unknown. */
    private static function testCustomer(): \Customer
    {
        $found = \Customer::getCustomersByEmail(self::TEST_CUSTOMER);
        if ($found !== []) {
            return new \Customer((int) $found[0]['id_customer']);
        }
        $customer = new \Customer();
        $customer->email = self::TEST_CUSTOMER;
        $customer->firstname = 'OpenReceive';
        $customer->lastname = 'Test';
        $customer->passwd = password_hash(bin2hex(random_bytes(24)), PASSWORD_BCRYPT);
        $customer->is_guest = false;
        $customer->active = true;
        $customer->newsletter = false;
        $customer->optin = false;
        $customer->note = 'Made by php bin/console openreceive:test-invoice --new for test orders. Safe to delete.';
        $customer->id_default_group = (int) \Configuration::get('PS_CUSTOMER_GROUP');
        if (!$customer->add()) {
            throw new \RuntimeException('PrestaShop did not save the test customer.');
        }
        $customer->updateGroup([(int) \Configuration::get('PS_CUSTOMER_GROUP')]);
        return $customer;
    }

    private static function testAddress(\Customer $customer): \Address
    {
        $id = (int) \Address::getFirstCustomerAddressId((int) $customer->id);
        if ($id > 0) {
            return new \Address($id);
        }
        $country = new \Country((int) \Configuration::get('PS_COUNTRY_DEFAULT'));
        $address = new \Address();
        $address->id_customer = (int) $customer->id;
        $address->alias = 'OpenReceive test';
        $address->firstname = 'OpenReceive';
        $address->lastname = 'Test';
        $address->address1 = '1 Test Street';
        $address->city = 'Test';
        $address->id_country = (int) $country->id;
        $address->postcode = strtr((string) $country->zip_code_format, ['N' => '1', 'L' => 'A', 'C' => (string) $country->iso_code]);
        $address->phone = '0000000000';
        if ($country->contains_states) {
            $states = \State::getStatesByIdCountry((int) $country->id, true);
            $address->id_state = (int) ($states[0]['id_state'] ?? 0);
        }
        if ($country->need_identification_number) {
            $address->dni = '0000000000';
        }
        if (!$address->add()) {
            throw new \RuntimeException('PrestaShop did not save the test customer\'s address.');
        }
        return $address;
    }

    /** A virtual product, so the order needs no carrier; hidden from the catalog and search. */
    private static function testProduct(string $amount): \Product
    {
        $id = (int) \Product::getIdByReference(self::TEST_PRODUCT);
        $product = new \Product($id > 0 ? $id : null);
        $languages = array_map('intval', array_column(\Language::getLanguages(false), 'id_lang'));
        $product->reference = self::TEST_PRODUCT;
        $product->name = array_fill_keys($languages, 'OpenReceive test payment');
        $product->link_rewrite = array_fill_keys($languages, 'openreceive-test-payment');
        $product->price = (float) $amount;
        $product->id_tax_rules_group = 0;
        $product->is_virtual = true;
        $product->visibility = 'none';
        $product->active = true;
        $product->available_for_order = true;
        $product->show_price = true;
        $product->id_category_default = (int) \Configuration::get('PS_HOME_CATEGORY');
        if (!($id > 0 ? $product->update() : $product->add())) {
            throw new \RuntimeException('PrestaShop did not save the test product.');
        }
        if ($id === 0) {
            $product->addToCategories([(int) \Configuration::get('PS_HOME_CATEGORY')]);
        }
        \StockAvailable::setProductOutOfStock((int) $product->id, 1);
        \StockAvailable::setQuantity((int) $product->id, 0, 1000);
        return $product;
    }
}
