# Run in `odoo shell -d shop` after BTCPay settled: the transaction as the
# notification left it, then the post-processing Odoo's cron would run, which
# confirms the order.
import os

tx = env["payment.transaction"].search([("reference", "=", os.environ["TX_REFERENCE"])])
state, status = tx.state, tx.btcpay_status
tx._post_process()
env.cr.commit()
order = tx.sale_order_ids
print(
    f"RESULT tx_state={state} btcpay_status={status} order_state={order.state} amount_paid={order.amount_paid}"
)
