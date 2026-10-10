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
chown -R 33:33 /var/www/html
