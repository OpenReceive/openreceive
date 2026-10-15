# Odoo 19 Community with BTCPay Server's payment addon (btcpayserver/odoo), for
# e2e.sh beside this file. The addon signs its requests with ecdsa, which the
# official image lacks.
FROM odoo:19.0
USER root
RUN pip3 install --no-cache-dir --break-system-packages ecdsa==0.19.1
ADD https://github.com/btcpayserver/odoo/archive/refs/tags/v19.0.1.1.tar.gz /tmp/btcpay-odoo.tar.gz
RUN tar -xzf /tmp/btcpay-odoo.tar.gz -C /tmp \
  && mv /tmp/odoo-19.0.1.1/payment_btcpayserver /mnt/extra-addons/ \
  && rm -rf /tmp/odoo-19.0.1.1 /tmp/btcpay-odoo.tar.gz
USER odoo
