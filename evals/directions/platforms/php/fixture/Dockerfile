FROM php:8.3-cli
RUN apt-get update && apt-get install -y --no-install-recommends unzip git libsqlite3-dev \
    && docker-php-ext-install pdo_sqlite \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
WORKDIR /app
COPY composer.json ./
RUN composer update --no-dev --no-interaction --no-plugins
COPY . .
RUN mkdir -p /data && chmod +x bin/product-count bin/openreceive-installed
ENV PHP_CLI_SERVER_WORKERS=1
EXPOSE 3000
CMD ["php", "-S", "0.0.0.0:3000", "-t", "public", "public/router.php"]
