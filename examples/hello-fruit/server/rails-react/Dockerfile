FROM ruby:3.3-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential automake pkg-config libtool libffi-dev libgmp-dev nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY packages/ruby ./packages/ruby
COPY examples/hello-fruit/server/rails-hotwire ./examples/hello-fruit/server/rails-hotwire

WORKDIR /app/examples/hello-fruit/server/rails-hotwire
RUN bundle install

ENV RAILS_ENV=production
ENV PORT=3003

EXPOSE 3003
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3003"]
