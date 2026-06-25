IMAGE ?= ghcr.io/openreceive/demo-nextjs:local
SMOKE_URL ?= http://127.0.0.1:3002/demo-metadata.json
COMPOSE ?= docker compose -f compose.yml -f compose.override.yml.example

.PHONY: setup dev test demo-test-nwc demo-production docker-build docker-run docker-smoke

setup:
	npm install

dev:
	npm run dev

test:
	npm run build

demo-test-nwc:
	OPENRECEIVE_DEMO_MODE=test_nwc $(COMPOSE) up --build

demo-production:
	OPENRECEIVE_DEMO_MODE=production $(COMPOSE) up --build

docker-build:
	docker build -f Dockerfile -t $(IMAGE) ../../../..

docker-run:
	$(COMPOSE) up

docker-smoke:
	curl -fsS $(SMOKE_URL)
