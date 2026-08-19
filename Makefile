# ─────────────────────────────────────────────────────────────────────────────
#  Nexara — Makefile
#
#  Stack management, build, and Docker Hub publish.
#
#  Services:  postgres · freeradius · api · web
#  Compose:   docker-compose.yml  (includes db + radius + app layers)
# ─────────────────────────────────────────────────────────────────────────────

# ── Configuration ─────────────────────────────────────────────────────────────
DOCKER_USER  ?= asiqurrahman
TAG          ?= 1.0.1
GIT_SHA      := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

API_IMAGE    := $(DOCKER_USER)/nexara-api
WEB_IMAGE    := $(DOCKER_USER)/nexara-web
RADIUS_IMAGE := $(DOCKER_USER)/nexara-radius

COMPOSE      := docker compose

.DEFAULT_GOAL := help

.PHONY: help up down restart rebuild logs \
        up-db up-radius up-app \
        build clean push \
        db-migrate db-seed db-shell \
        ps status

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  Nexara — Docker targets"
	@echo "  ─────────────────────────────────────────────────────────"
	@echo ""
	@echo "  Stack"
	@echo "    make up              Start full stack (db → radius → api → web)"
	@echo "    make down            Stop all containers (volumes kept)"
	@echo "    make restart         Restart all containers"
	@echo "    make rebuild         Rebuild images and restart"
	@echo "    make ps              Show running containers"
	@echo "    make status          Show container status + ports"
	@echo "    make logs            Tail all container logs"
	@echo "    make logs s=api      Tail logs for a single service"
	@echo ""
	@echo "  Layers (start independently)"
	@echo "    make up-db           Start PostgreSQL only"
	@echo "    make up-radius       Start PostgreSQL + FreeRADIUS"
	@echo "    make up-app          Start PostgreSQL + API + Web"
	@echo ""
	@echo "  Build"
	@echo "    make build           Build all images locally"
	@echo "    make clean           Stop stack, remove volumes + images"
	@echo ""
	@echo "  Push to Docker Hub"
	@echo "    make push            Interactive — shows last version, pick next"
	@echo "    make push VERSION=x.y.z  Non-interactive"
	@echo ""
	@echo "  Database"
	@echo "    make db-migrate      Run Prisma migrations (inside api container)"
	@echo "    make db-seed         Seed first admin user"
	@echo "    make db-shell        Open psql shell in postgres container"
	@echo ""
	@echo "  Images: $(API_IMAGE)  $(WEB_IMAGE)  $(RADIUS_IMAGE)"
	@echo "  Git:    $(GIT_SHA)"
	@echo ""

# ── Stack ─────────────────────────────────────────────────────────────────────
up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down --remove-orphans

restart: down up

rebuild:
	$(COMPOSE) up -d --build

logs:
ifdef s
	$(COMPOSE) logs -f $(s)
else
	$(COMPOSE) logs -f
endif

ps:
	$(COMPOSE) ps

status:
	$(COMPOSE) ps --format "table {{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Ports}}"

# ── Layer shortcuts ───────────────────────────────────────────────────────────
up-db:
	$(COMPOSE) -f docker-compose.db.yml up -d

up-radius:
	$(COMPOSE) -f docker-compose.db.yml -f docker-compose.radius.yml up -d

up-app:
	$(COMPOSE) -f docker-compose.db.yml -f docker-compose.app.yml up -d

# ── Build ─────────────────────────────────────────────────────────────────────
build:
	docker build -f apps/api/Dockerfile \
		-t $(API_IMAGE):$(TAG) \
		.
	docker build -f apps/web/Dockerfile \
		-t $(WEB_IMAGE):$(TAG) \
		.
	docker build -f infra/freeradius/Dockerfile \
		-t $(RADIUS_IMAGE):$(TAG) \
		infra/freeradius

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	$(COMPOSE) down -v --remove-orphans
	-docker image rm -f \
		$(API_IMAGE):$(TAG) \
		$(WEB_IMAGE):$(TAG) \
		$(RADIUS_IMAGE):$(TAG)
	-docker image prune -f

# ── Push (interactive version picker) ─────────────────────────────────────────
push:
	node ops/docker-push.mjs $(if $(VERSION),--version $(VERSION),)

# ── Database ──────────────────────────────────────────────────────────────────
db-migrate:
	docker exec nexara-api node ./node_modules/prisma/build/index.js migrate deploy

db-seed:
	docker exec nexara-api node --openssl-legacy-provider prisma/seed.mjs

db-shell:
	docker exec -it nexara-postgres psql -U $${POSTGRES_USER:-radius} -d $${POSTGRES_DB:-radius}
