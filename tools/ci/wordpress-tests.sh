#!/usr/bin/env bash
set -euo pipefail
# This script only uses the disposable Docker testkit stack, never a host app.
container="openreceive-wp-test-wordpress-1"
wp() { docker exec -u www-data "$container" wp "$@"; }
wp eval 'if (!defined("OPENRECEIVE_DEMO_WALLET") || OPENRECEIVE_DEMO_WALLET !== "testkit") { exit(1); }'
original_hpos="$(wp option get woocommerce_custom_orders_table_enabled)"
trap 'wp wc hpos sync >/dev/null; wp option update woocommerce_custom_orders_table_enabled "$original_hpos" >/dev/null' EXIT
for hpos in yes no; do
  wp wc hpos sync
  wp option update woocommerce_custom_orders_table_enabled "$hpos"
  wp eval-file /opt/demo/integration.php
done
