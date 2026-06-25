IMAGE ?= ghcr.io/openreceive/demo-rails-react:local
COMPOSE ?= docker compose -f compose.yml -f compose.override.yml.example
SMOKE_URL ?= http://127.0.0.1:3003/demo-metadata.json

setup:
	bundle install

dev:
	bundle exec rails server -b 0.0.0.0 -p $${PORT:-3003}

test:
	bundle exec rails runner 'puts "rails-react quarantined skeleton ok"'

demo-test-nwc:
	OPENRECEIVE_DEMO_MODE=test_nwc $(COMPOSE) up --build

demo-production:
	OPENRECEIVE_DEMO_MODE=production $(COMPOSE) up --build

docker-build:
	docker build -t $(IMAGE) -f Dockerfile ../../../..

docker-run:
	$(COMPOSE) up

docker-smoke:
	curl -fsS $(SMOKE_URL)
