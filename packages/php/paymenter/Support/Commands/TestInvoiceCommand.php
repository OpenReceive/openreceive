<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support\Commands;

use App\Models\Currency;
use App\Models\Invoice;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Endpoint;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Runtime;

/**
 * `php artisan openreceive:test-invoice <invoice id>` — makes a Lightning
 * invoice for an unpaid Paymenter invoice through the same route the payment
 * dialog uses, acting as the client the invoice belongs to. `--new` first
 * creates a small unpaid invoice billed to an admin, without Paymenter's
 * new-invoice email.
 */
final class TestInvoiceCommand extends Command
{
    protected $signature = 'openreceive:test-invoice
        {invoice? : The id of an unpaid Paymenter invoice}
        {--new : Create a small unpaid test invoice first}
        {--amount=5.00 : The test invoice\'s amount, with --new}
        {--user= : The email of the account to bill, with --new (default: the first admin)}';

    protected $description = 'Make a Lightning invoice for an unpaid Paymenter invoice, through the payment dialog\'s own route';

    public function handle(): int
    {
        if ($this->option('new')) {
            $invoice = $this->createTestInvoice();
            if ($invoice === null) {
                return self::FAILURE;
            }
        } else {
            $id = (string) $this->argument('invoice');
            $invoice = ctype_digit($id) ? Invoice::find((int) $id) : null;
            if ($invoice === null || $invoice->status !== Invoice::STATUS_PENDING) {
                $this->error("Invoice {$id} is not an unpaid Paymenter invoice. Pass an unpaid invoice's id, or --new to create a test invoice.");
                return self::FAILURE;
            }
        }

        Auth::onceUsingId($invoice->user_id);
        $request = Request::create('/' . Runtime::PREFIX . '/checkouts', 'POST', server: ['CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => '127.0.0.1'], content: (string) json_encode(['reference' => (string) $invoice->id]));
        $response = (new Endpoint())->api($request);
        $body = json_decode((string) $response->getContent(), true) ?: [];
        if ($response->getStatusCode() !== 201) {
            $this->error(sprintf('%s (HTTP %d, request_id %s)', $body['message'] ?? 'Checkout failed.', $response->getStatusCode(), $body['request_id'] ?? 'none'));
            return self::FAILURE;
        }
        $checkout = $body['checkout'];
        $this->line('Invoice: ' . $checkout['bolt11']);
        $this->line('Payment hash: ' . $checkout['payment_hash']);
        $this->line('Invoice page (its Pay button opens the checkout on this invoice): ' . route('invoices.show', $invoice));
        $methods = array_filter($body['payment_methods'] ?? [], 'is_array');
        if ($methods === []) {
            $this->line('Checkout methods: Bitcoin Lightning only (no swap provider configured).');
        } else {
            $this->line('Checkout methods in the payment dialog:');
            $this->line('  Bitcoin Lightning: available');
            foreach ($methods as $method) {
                $this->line(sprintf('  %s on %s: %s', $method['label'] ?? '?', $method['network_label'] ?? '?',
                    ($method['available'] ?? false) ? 'available' : 'unavailable — ' . ($method['unavailable_message'] ?? $method['unavailable_reason'] ?? 'no reason given')));
            }
        }
        $this->info(sprintf('Invoice #%s: %s sats for %s %s, expires %s UTC.', $invoice->number ?: $invoice->id, number_format(intdiv((int) $checkout['amount_msats'], 1000)), number_format((float) $invoice->remaining, 2, '.', ''), $invoice->currency_code, gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
        return self::SUCCESS;
    }

    private function createTestInvoice(): ?Invoice
    {
        $amount = (string) $this->option('amount');
        if (!preg_match('/\A[0-9]{1,9}(\.[0-9]{1,2})?\z/', $amount) || (float) $amount <= 0) {
            $this->error('--amount must be a positive amount such as 5.00.');
            return null;
        }
        $email = $this->option('user');
        $user = is_string($email) && $email !== ''
            ? User::where('email', $email)->first()
            : User::whereNotNull('role_id')->orderBy('id')->first();
        if ($user === null) {
            $this->error(is_string($email) && $email !== '' ? "No account has the email {$email}." : 'No admin account found. Pass --user=<email> of the account to bill.');
            return null;
        }
        $currency = (string) (config('settings.default_currency') ?: Currency::query()->value('code') ?: 'USD');
        $invoice = new Invoice(['user_id' => $user->id, 'currency_code' => $currency, 'status' => Invoice::STATUS_PENDING, 'due_at' => now()]);
        // A test invoice is not news for the account it bills.
        $invoice->send_create_email = false;
        $invoice->save();
        $invoice->items()->create(['description' => 'OpenReceive test invoice', 'price' => $amount, 'quantity' => 1]);
        $invoice = $invoice->fresh();
        $this->line(sprintf('Created test invoice #%s (id %d) for %s, billed to %s. Cancel it in the admin area when you are done.', $invoice->number ?: $invoice->id, $invoice->id, "{$amount} {$currency}", $user->email));
        return $invoice;
    }
}
