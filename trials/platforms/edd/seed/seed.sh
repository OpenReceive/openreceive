#!/bin/sh
# Installs WordPress and Easy Digital Downloads into the stock images. The agent
# does not run this; the harness does, before the agent sees the shop.
set -eu
cd /var/www/html
if ! wp core is-installed >/dev/null 2>&1; then
  wp core install \
    --url="${SHOP_URL:?}" \
    --title="Widget Downloads" \
    --admin_user=shop \
    --admin_password="${SHOP_ADMIN_PASSWORD:?}" \
    --admin_email=shop@example.test \
    --skip-email
fi
if ! wp plugin is-active easy-digital-downloads >/dev/null 2>&1; then
  wp plugin install easy-digital-downloads --version=3.7.2 --activate
fi
wp rewrite structure '/%postname%/' >/dev/null
wp eval-file /seed/downloads.php
# The trial's must-use plugin is a read-only bind mount (compose.yml).
find /var/www/html ! -path /var/www/html/wp-content/mu-plugins/trust-system-cas.php \
  -exec chown 33:33 {} +
