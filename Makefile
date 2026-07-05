# Forge convenience commands. These ONLY delegate to Docker / Docker Compose.
# No local Node, npm, or build tools are ever assumed.

.PHONY: up down logs shell test build ps restart

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f api

shell:
	docker compose exec api sh

ps:
	docker compose ps

restart:
	docker compose restart api

# Forge's own platform tests (run inside the container).
test:
	docker compose exec -T api ./node_modules/.bin/vitest run

# Rebuild the platform image.
build:
	docker compose build
