FROM php:8.4-cli
RUN apt-get update && apt-get install -y --no-install-recommends unzip git libsqlite3-dev \
    && docker-php-ext-install pdo_sqlite \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-scripts
COPY . .
RUN mkdir -p /data storage/framework/sessions storage/framework/views storage/framework/cache storage/logs bootstrap/cache \
    && composer dump-autoload --no-dev --no-interaction \
    && cp .env.example .env \
    && php artisan key:generate --force \
    && chmod +x bin/product-count bin/openreceive-installed bin/order-status
ENV DB_DATABASE=/data/shop.sqlite
EXPOSE 3000
CMD ["sh", "-c", "php artisan migrate --force && php artisan serve --host=0.0.0.0 --port=3000"]
