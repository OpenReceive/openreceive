FROM node:22-bookworm-slim AS client
WORKDIR /build
COPY package.json package-lock.json ./
COPY tsconfig*.json ./
COPY packages/js ./packages/js
COPY examples/buttons ./examples/buttons
COPY tools ./tools
COPY spec ./spec
RUN npm ci --no-audit && npm run build:packages

FROM wordpress:7.1-php8.2-apache AS php-base
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev unzip zip git default-mysql-client \
    && docker-php-ext-install gmp \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
RUN curl -fsSL https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar -o /usr/local/bin/wp \
    && chmod +x /usr/local/bin/wp

FROM php-base AS plugin
COPY --from=client /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY package.json ./
COPY packages/php/openreceive ./packages/php/openreceive
COPY packages/php/wordpress ./packages/php/wordpress
COPY tools/release/wordpress-plugin.mjs ./tools/release/wordpress-plugin.mjs
COPY tools/shared/root.mjs ./tools/shared/root.mjs
COPY --from=client /build/packages/js/elements/dist/standalone ./packages/js/elements/dist/standalone
RUN composer install --working-dir=packages/php/wordpress --no-interaction --no-progress --prefer-dist \
    && node tools/release/wordpress-plugin.mjs build

FROM php-base
ARG WOOCOMMERCE_VERSION=11.1.0
RUN curl -fsSL "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip" -o /tmp/woocommerce.zip \
    && unzip -q /tmp/woocommerce.zip -d /usr/src/wordpress/wp-content/plugins \
    && rm /tmp/woocommerce.zip
COPY --from=plugin /build/dist/wordpress-build/openreceive /usr/src/wordpress/wp-content/plugins/openreceive
COPY examples/wordpress/seed.php examples/wordpress/entrypoint.sh /opt/demo/
COPY examples/buttons/shared/shop-catalog.json /opt/demo/shop-catalog.json
COPY examples/buttons/images /opt/demo/images
COPY packages/php/wordpress/tests/integration.php /opt/demo/integration.php
RUN chmod +x /opt/demo/entrypoint.sh \
    && sed -i 's/Listen 80/Listen 3009/' /etc/apache2/ports.conf \
    && sed -i 's/:80>/:3009>/' /etc/apache2/sites-available/000-default.conf
EXPOSE 3009
ENTRYPOINT ["/opt/demo/entrypoint.sh"]
CMD ["apache2-foreground"]
