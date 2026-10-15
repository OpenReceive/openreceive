#!/bin/sh
# Installs the store against the stack's MariaDB and OpenSearch, then the
# merchant's BTCPay settings: the server, an API key and the BTCPay store.
# Needs BTCPAY_API_KEY and BTCPAY_STORE_ID. Runs as www-data, which owns the
# store, so the files it writes stay writable by Apache.
set -eu
cd /var/www/html
mkdir -p var/log
# The installer's progress goes to a log; a failure prints its end.
quiet() { "$@" > var/log/install-store.log 2>&1 || { tail -n 40 var/log/install-store.log; exit 1; }; }
quiet bin/magento setup:install --no-interaction --base-url=http://magento/ \
  --db-host=magento-db --db-name=magento --db-user=magento --db-password=magento \
  --admin-firstname=Shop --admin-lastname=Owner --admin-email=owner@widget-shop.test \
  --admin-user=owner --admin-password=Widget-shop-local-1 \
  --language=en_US --currency=USD --timezone=UTC --use-rewrites=1 \
  --search-engine=opensearch --opensearch-host=opensearch --opensearch-port=9200 \
  --opensearch-enable-auth=0 --backend-frontname=admin
# The REST admin token below; a merchant signs in with 2FA instead.
quiet bin/magento module:disable Magento_TwoFactorAuth
quiet bin/magento setup:upgrade --keep-generated
bin/magento config:set payment/btcpay/btcpay_base_url http://btcpayserver:49392
bin/magento config:set payment/btcpay/api_key "$BTCPAY_API_KEY"
# Saving the BTCPay store fires the module's admin observer, which asks for
# the current store: on the command line there is none, so it throws a
# TypeError after the value is saved (magento2-plugin 2.0.12). The admin page
# has a store; install-webhook.php does that observer's work afterwards.
if ! out=$(bin/magento config:set --scope=stores --scope-code=default \
  payment/btcpay/btcpay_store_id "$BTCPAY_STORE_ID" 2>&1); then
  case "$out" in
    *"installWebhookIfNeeded(): Argument #1 (\$magentoStoreId) must be of type int, null given"*) ;;
    *) echo "$out"; exit 1 ;;
  esac
fi
bin/magento cache:flush

