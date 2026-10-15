# PrestaShop 9.2 (the official image, which installs the shop on its first
# start against the stack's MariaDB) with BTCPay Server's PrestaShop module
# (btcpayserver/prestashop-plugin), for trials/harness/btcpay-route.ts.
FROM prestashop/prestashop:9.2.0-apache
ADD https://github.com/btcpayserver/prestashop-plugin/releases/download/v6.3.3/btcpay.zip /tmp/btcpay.zip
# The installer runs as www-data and renames admin/ to a random name, so
# www-data must own the shop root, which is root's in the 9.2.0 image.
RUN unzip -q /tmp/btcpay.zip -d /var/www/html/modules \
  && rm /tmp/btcpay.zip \
  && chown -R www-data:www-data /var/www/html/modules/btcpay \
  && chown www-data:www-data /var/www/html
# PrestaShop 9.2's installer deletes install/ itself, and the image's start
# script then fails on its own rm of it, after a successful install.
RUN sed -i 's|rm -r /var/www/html/$PS_FOLDER_INSTALL/|rm -rf /var/www/html/$PS_FOLDER_INSTALL/|' /tmp/docker_run.sh \
  && grep -q 'rm -rf /var/www/html/$PS_FOLDER_INSTALL/' /tmp/docker_run.sh
COPY connect-btcpay.php checkout.php order-state.php /usr/local/share/btcpay-route/
