# Mage-OS (Magento Open Source without Adobe's marketplace keys) with BTCPay
# Server's Magento module (btcpayserver/magento2-plugin), for
# trials/harness/btcpay-route.ts. The store is installed when the stack runs,
# because setup:install needs the database and OpenSearch.
FROM php:8.3-apache
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git unzip libfreetype6-dev libjpeg62-turbo-dev \
    libpng-dev libicu-dev libxslt1-dev libzip-dev libsodium-dev \
  && docker-php-ext-configure gd --with-freetype --with-jpeg \
  && docker-php-ext-install -j"$(nproc)" bcmath gd intl pdo_mysql soap sockets xsl zip ftp \
  && a2enmod rewrite \
  && rm -rf /var/lib/apt/lists/*
RUN printf 'memory_limit=4G\nmax_execution_time=1800\nrealpath_cache_size=10M\n' > /usr/local/etc/php/conf.d/magento.ini \
  && sed -ri 's!/var/www/html!/var/www/html/pub!g' /etc/apache2/sites-available/000-default.conf
COPY --from=composer:2.8 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
ENV COMPOSER_ALLOW_SUPERUSER=1
RUN rm -rf /var/www/html/* \
  && composer create-project --no-interaction --no-progress \
    --repository-url=https://repo.mage-os.org/ mage-os/project-community-edition . \
  && composer require --no-interaction --no-progress btcpayserver/magento2-btcpay-module:2.0.12 \
  && chown -R www-data:www-data /var/www/html
COPY --chmod=755 install.sh /usr/local/bin/install-store
COPY forward-to-payment.php install-webhook.php order-state.php /usr/local/share/btcpay-route/
