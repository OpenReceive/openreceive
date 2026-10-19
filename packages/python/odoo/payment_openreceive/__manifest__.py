{
    "name": "Payment Provider: OpenReceive",
    "version": "0.4.29",
    "category": "Accounting/Payment Providers",
    "sequence": 350,
    "summary": "Bitcoin Lightning payments straight into your own wallet. "
    "Optional USDT, USDC, SOL and ETH swaps settle as BTC over Lightning.",
    "description": " ",  # Non-empty string to avoid loading the README file.
    "author": "OpenReceive",
    "website": "https://openreceive.org/integrations/odoo",
    "depends": ["payment"],
    "external_dependencies": {"python": ["openreceive"]},
    "data": [
        "views/payment_openreceive_templates.xml",
        "views/payment_provider_views.xml",
        "data/payment_provider_data.xml",
        "data/ir_cron_data.xml",
    ],
    "post_init_hook": "post_init_hook",
    "uninstall_hook": "uninstall_hook",
    "license": "Other OSI approved licence",
    "installable": True,
}
