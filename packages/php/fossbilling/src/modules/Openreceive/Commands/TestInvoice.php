<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Commands;

use Box\Mod\Openreceive\Support\Endpoint;
use Box\Mod\Openreceive\Support\Host;
use Box\Mod\Openreceive\Support\Runtime;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\HttpFoundation\Request;

/**
 * `php console.php openreceive:test-invoice <invoice id>` — makes a
 * Lightning invoice for an unpaid FOSSBilling invoice through the same route
 * the payment page uses. `--new` first creates a small unpaid test invoice,
 * billed to a test client it creates once (openreceive-test@example.invalid),
 * so no real client sees it.
 */
#[AsCommand(name: 'openreceive:test-invoice', description: 'Make a Lightning invoice for an unpaid FOSSBilling invoice, through the payment page\'s own route')]
class TestInvoice extends Command implements \FOSSBilling\InjectionAwareInterface
{
    public const TEST_CLIENT = 'openreceive-test@example.invalid';

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
        $this->addArgument('invoice', InputArgument::OPTIONAL, 'The id of an unpaid FOSSBilling invoice');
        $this->addOption('new', null, InputOption::VALUE_NONE, 'Create a small unpaid test invoice first');
        $this->addOption('amount', null, InputOption::VALUE_REQUIRED, 'The test invoice\'s amount, with --new', '5.00');
        $this->addOption('client', null, InputOption::VALUE_REQUIRED, 'The email of the client to bill, with --new (default: a test client, created once)');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        if ($input->getOption('new')) {
            $invoice = $this->createTestInvoice($input, $output);
            if ($invoice === null) {
                return Command::FAILURE;
            }
        } else {
            $id = (string) $input->getArgument('invoice');
            $invoice = Host::invoice($id);
            if ($invoice === null || $invoice->status !== \Model_Invoice::STATUS_UNPAID) {
                $output->writeln("<error>Invoice {$id} is not an unpaid FOSSBilling invoice. Pass an unpaid invoice's id, or --new to create a test invoice.</error>");
                return Command::FAILURE;
            }
        }

        $request = Request::create(Runtime::PREFIX . '/checkouts', 'POST', server: ['CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => '127.0.0.1'], content: (string) json_encode(['reference' => (string) $invoice->id]));
        $response = Endpoint::api($request, 'checkouts');
        $body = json_decode((string) $response->getContent(), true) ?: [];
        if ($response->getStatusCode() !== 201) {
            $output->writeln(sprintf('<error>%s (HTTP %d, request_id %s)</error>', $body['message'] ?? 'Checkout failed.', $response->getStatusCode(), $body['request_id'] ?? 'none'));
            return Command::FAILURE;
        }
        $checkout = $body['checkout'];
        $output->writeln('Invoice: ' . $checkout['bolt11']);
        $output->writeln('Payment hash: ' . $checkout['payment_hash']);
        $output->writeln('Invoice page (choose the payment method there to open the checkout): ' . $this->di['tools']->url('/invoice/' . $invoice->hash));
        $methods = array_filter($body['payment_methods'] ?? [], 'is_array');
        if ($methods === []) {
            $output->writeln('Checkout methods: Bitcoin Lightning only (no swap provider configured).');
        } else {
            $output->writeln('Checkout methods on the payment page:');
            $output->writeln('  Bitcoin Lightning: available');
            foreach ($methods as $method) {
                $output->writeln(sprintf('  %s on %s: %s', $method['label'] ?? '?', $method['network_label'] ?? '?',
                    ($method['available'] ?? false) ? 'available' : 'unavailable — ' . ($method['unavailable_message'] ?? $method['unavailable_reason'] ?? 'no reason given')));
            }
        }
        $total = number_format($this->di['mod_service']('Invoice')->getTotalWithTax($invoice), 2, '.', '');
        $output->writeln(sprintf('<info>Invoice %s: %s sats for %s %s, expires %s UTC.</info>', Host::number($invoice), number_format(intdiv((int) $checkout['amount_msats'], 1000)), $total, $invoice->currency, gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
        return Command::SUCCESS;
    }

    private function createTestInvoice(InputInterface $input, OutputInterface $output): ?\Model_Invoice
    {
        $amount = (string) $input->getOption('amount');
        if (!preg_match('/\A[0-9]{1,9}(\.[0-9]{1,2})?\z/', $amount) || (float) $amount <= 0) {
            $output->writeln('<error>--amount must be a positive amount such as 5.00.</error>');
            return null;
        }
        $email = $input->getOption('client');
        if (is_string($email) && $email !== '') {
            $client = $this->di['db']->findOne('Client', 'email = :email', [':email' => $email]);
            if (!$client instanceof \Model_Client) {
                $output->writeln("<error>No client has the email {$email}.</error>");
                return null;
            }
        } else {
            $client = $this->testClient();
        }
        $invoice = $this->di['mod_service']('Invoice')->prepareInvoice($client, ['items' => [['title' => 'OpenReceive test invoice', 'price' => $amount, 'quantity' => 1]]]);
        $output->writeln(sprintf('Created test invoice %s (id %d) for %s %s, billed to %s. Delete it in the admin area when you are done.', Host::number($invoice), $invoice->id, $amount, $invoice->currency, $client->email));
        return $invoice;
    }

    /** A client only for test invoices, made once. It never signs in: its password is random and unknown. */
    private function testClient(): \Model_Client
    {
        $client = $this->di['db']->findOne('Client', 'email = :email', [':email' => self::TEST_CLIENT]);
        if ($client instanceof \Model_Client) {
            return $client;
        }
        $client = $this->di['db']->dispense('Client');
        $client->email = self::TEST_CLIENT;
        $client->first_name = 'OpenReceive';
        $client->last_name = 'Test';
        $client->role = 'client';
        $client->status = 'active';
        $client->email_approved = 1;
        $client->pass = (new \FOSSBilling\PasswordManager())->hashIt(bin2hex(random_bytes(24)));
        $client->notes = 'Created by php console.php openreceive:test-invoice --new for test invoices. Safe to delete.';
        $client->created_at = date('Y-m-d H:i:s');
        $client->updated_at = date('Y-m-d H:i:s');
        $this->di['db']->store($client);
        return $client;
    }
}
