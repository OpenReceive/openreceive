#!/bin/sh
# Installs WordPress and WooCommerce into the stock images. The agent does not
# run this; the harness does, before the agent sees the shop.
set -eu
cd /var/www/html
if ! wp core is-installed >/dev/null 2>&1; then
  wp core install \
    --url="${SHOP_URL:?}" \
    --title="Widget Shop" \
    --admin_user=shop \
    --admin_password="${SHOP_ADMIN_PASSWORD:?}" \
    --admin_email=shop@example.test \
    --skip-email
fi
if ! wp plugin is-active woocommerce >/dev/null 2>&1; then
  wp plugin install woocommerce --activate
fi
wp option update woocommerce_coming_soon no >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null
wp rewrite structure '/%postname%/' >/dev/null
wp eval-file /seed/products.php
# The trial's must-use plugin is a read-only bind mount (compose.yml).
find /var/www/html ! -path /var/www/html/wp-content/mu-plugins/trust-system-cas.php \
  -exec chown 33:33 {} +
