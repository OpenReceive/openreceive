#!/usr/bin/env bash
set -euo pipefail
# This script only uses the disposable Docker testkit stack, never a host app.
container="openreceive-wp-test-wordpress-1"
wp() { docker exec -i -u www-data "$container" wp "$@"; }
wp eval 'if (!defined("OPENRECEIVE_DEMO_WALLET") || OPENRECEIVE_DEMO_WALLET !== "testkit") { exit(1); }'
original_hpos="$(wp option get woocommerce_custom_orders_table_enabled)"
trap 'wp wc hpos sync >/dev/null; wp option update woocommerce_custom_orders_table_enabled "$original_hpos" >/dev/null' EXIT
for hpos in yes no; do
  wp wc hpos sync
  wp option update woocommerce_custom_orders_table_enabled "$hpos"
  wp eval-file /opt/demo/integration.php
done

# CLI failures are automation failures, and unsupported argv credentials are
# never echoed. Opaque test text is deliberately not a wallet credential.
wp eval 'update_option("openreceive_cli_test_settings", get_option("woocommerce_openreceive_settings", []));'
printf '%s' 'opaque-cli-test' | wp openreceive configure --nwc-uri=-
wp eval '$s=get_option("woocommerce_openreceive_settings"); if ($s["nwc_uri"] === "opaque-cli-test" || OpenReceive\WP\Secrets::decrypt($s["nwc_uri"]) !== "opaque-cli-test") { exit(1); }'
if output="$(wp openreceive configure --nwc-uri=- < /dev/null 2>&1)"; then
  echo "configure accepted empty stdin" >&2; exit 1
fi
wp eval 'update_option("woocommerce_openreceive_settings", get_option("openreceive_cli_test_settings")); delete_option("openreceive_cli_test_settings");'
wp openreceive configure --enable
wp openreceive doctor
if output="$(wp openreceive configure --nwc-uri=opaque-cli-test 2>&1)"; then
  echo "configure accepted a credential argument" >&2; exit 1
fi
if [[ "$output" == *opaque-cli-test* || "$output" != *stdin* ]]; then
  echo "configure did not safely reject the argument" >&2; exit 1
fi
if output="$(wp --skip-plugins=woocommerce openreceive doctor 2>&1)"; then
  echo "doctor succeeded without WooCommerce" >&2; exit 1
fi
if [[ "$output" != *"WooCommerce: FAILED"* ]]; then
  echo "doctor did not identify the failed dependency" >&2; exit 1
fi

# The doctor a merchant runs prints no Node instructions.
output="$(wp openreceive doctor)"
if [[ "$output" == *npx* ]]; then
  echo "doctor printed a Node command" >&2; exit 1
fi
if [[ "$output" != *"Swap provider fixedfloat: answered"* ]]; then
  echo "doctor did not check the swap provider: $output" >&2; exit 1
fi

# test-invoice mints through the order-pay route, for the order an agent creates
# with the documented WooCommerce CLI command, and refuses an order it cannot charge.
product="$(wp eval 'echo wc_get_product_id_by_sku("safety-orange");')"
order="$(wp wc shop_order create --user=demo --payment_method=openreceive \
  --line_items="[{\"product_id\":${product},\"quantity\":1}]" --porcelain)"
output="$(wp openreceive test-invoice "$order")"
if [[ "$output" != *"Invoice: ln"* || "$output" != *" sats for "* || "$output" != *order-pay*"$order"* ]]; then
  echo "test-invoice did not print the invoice: $output" >&2; exit 1
fi
if [[ "$output" != *"Checkout methods on the order-pay page:"* || "$output" != *"USDC on Solana: available"* ]]; then
  echo "test-invoice did not list the checkout methods: $output" >&2; exit 1
fi
wp eval "if (count(OpenReceive\WP\Plugin::repository()->listForReference('$order')) !== 1) { exit(1); }"
if output="$(wp openreceive test-invoice 999999999 2>&1)"; then
  echo "test-invoice accepted a missing order" >&2; exit 1
fi
wp wc shop_order delete "$order" --force=true --user=demo >/dev/null
