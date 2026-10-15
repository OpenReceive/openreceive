<?php
// php order-state.php <cart id>
// The cart's order: its state against the module's "paid" state, and what
// PrestaShop recorded as paid.
require '/var/www/html/config/config.inc.php';

$order = Order::getByCartId((int) $argv[1]);
if ($order === null) {
    echo "RESULT order=0\n";
    exit;
}
$paidState = (int) Configuration::get('BTCPAY_OS_PAID');
$total = $order->total_paid;
$paid = $order->total_paid_real;
echo "RESULT order={$order->id} state={$order->current_state} paid_state={$paidState} "
    . "valid={$order->valid} total={$total} paid={$paid}\n";
