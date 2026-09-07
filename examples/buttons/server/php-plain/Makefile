IMAGE ?= ghcr.io/openreceive/demo-buttons-php-plain:local
SMOKE_URL ?= http://127.0.0.1:3008/
COMPOSE ?= docker compose -f compose.yml -f compose.override.yml.example

.PHONY: setup dev test demo docker-build docker-run docker-smoke

setup:
	composer install
	npm install

dev:
	npm run dev

test:
	bin/ci

# Builds the image and runs its production server; NWC_URI comes from the repo-root .env.
demo:
	$(COMPOSE) up --build

docker-build:
	docker build -f Dockerfile -t $(IMAGE) ../../../..

docker-run:
	$(COMPOSE) up

docker-smoke:
	curl -fsS $(SMOKE_URL)
