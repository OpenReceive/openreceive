FROM ruby:3.3-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libsqlite3-dev libyaml-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle config set --local without "" && bundle install
COPY . .
RUN mkdir -p /data tmp/pids tmp/cache log && chmod +x bin/product-count bin/openreceive-installed bin/order-status && chown -R nobody:nogroup /app /data
USER nobody
ENV RAILS_ENV=production
ENV SECRET_KEY_BASE=widget-shop-local-secret-key-base-not-for-production-use-only-0123456789
EXPOSE 3000
CMD ["bundle", "exec", "puma", "-b", "tcp://0.0.0.0:3000", "config.ru"]
