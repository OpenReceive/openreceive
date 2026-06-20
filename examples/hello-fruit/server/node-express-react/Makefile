IMAGE ?= ghcr.io/openreceive/demo-express:local
HEALTH_URL ?= http://127.0.0.1:3000/healthz

.PHONY: setup dev test demo-test-nwc demo-production docker-build docker-run docker-smoke

setup:
	npm install

dev:
	npm run dev

test:
	npm run build

demo-test-nwc:
	OPENRECEIVE_DEMO_MODE=test_nwc docker compose up --build

demo-production:
	OPENRECEIVE_DEMO_MODE=production docker compose up --build

docker-build:
	docker build -f Dockerfile -t $(IMAGE) ../../../..

docker-run:
	docker compose up

docker-smoke:
	curl -fsS $(HEALTH_URL)
