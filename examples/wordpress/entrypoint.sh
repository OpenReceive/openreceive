#!/usr/bin/env bash
set -euo pipefail
# Let the official entrypoint initialize WordPress/config, then seed before Apache.
if [ "${1:-}" != "apache2-foreground" ]; then exec docker-entrypoint.sh "$@"; fi
if [ -n "${OPENRECEIVE_TESTKIT_DIR:-}" ]; then
  mkdir -p "$OPENRECEIVE_TESTKIT_DIR"
  chown www-data:www-data "$OPENRECEIVE_TESTKIT_DIR"
fi
docker-entrypoint.sh apache2-foreground &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' TERM INT
for attempt in $(seq 1 90); do
  if [ -f /var/www/html/wp-config.php ] && php -r 'mysqli_report(MYSQLI_REPORT_OFF); $db = new mysqli(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")); exit($db->connect_errno ? 1 : 0);' >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! wp --allow-root core is-installed >/dev/null 2>&1; then
  wp --allow-root core install --url="${DEMO_SITE_URL:-http://localhost:3009}" \
    --title="Buy a Button — WooCommerce" --admin_user=demo \
    --admin_password="${DEMO_ADMIN_PASSWORD:-openreceive-local-demo}" --admin_email=demo@example.test --skip-email
fi
# Refresh plugin code on rebuild even when the WordPress volume already exists.
cp -a /usr/src/wordpress/wp-content/plugins/openreceive/. /var/www/html/wp-content/plugins/openreceive/
wp --allow-root plugin activate woocommerce openreceive
wp --allow-root eval-file /opt/demo/seed.php
chown -R www-data:www-data /var/www/html/wp-content
touch /tmp/openreceive-demo-ready
wait "$server_pid"
