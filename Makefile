# Forge convenience commands. These ONLY delegate to Docker / Docker Compose.
# No local Node, npm, or build tools are ever assumed.

.PHONY: up down logs shell test build ps restart

# --force-recreate closes the P14 sibling trap: the control-plane container runs
# `restart: unless-stopped`, and `compose up` alone will NOT swap a running container
# when only its image changed (a rebuilt/re-pinned FORGE_IMAGE) — it silently keeps the
# old one until a manual --force-recreate. Forcing recreation here means `make up` always
# lands the freshly-built/pinned image instead of leaving `forge productionize`/commands
# on a stale one.
up:
	docker compose up -d --build --force-recreate

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
