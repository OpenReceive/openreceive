IMAGE ?= ghcr.io/openreceive/demo-express:local
HEALTH_URL ?= http://127.0.0.1:3000/healthz
COMPOSE ?= docker compose -f compose.yml -f compose.override.yml.example

.PHONY: setup dev test demo-test-nwc demo-production docker-build docker-run docker-smoke

setup:
	npm install

dev:
	npm run dev

test:
	npm run build

demo-test-nwc:
	OPENRECEIVE_DEMO_MODE=test_nwc $(COMPOSE) --profile openreceive-worker up --build

demo-production:
	OPENRECEIVE_DEMO_MODE=production $(COMPOSE) --profile openreceive-worker up --build

docker-build:
	docker build -f Dockerfile -t $(IMAGE) ../../../..

docker-run:
	$(COMPOSE) up

docker-smoke:
	curl -fsS $(HEALTH_URL)
