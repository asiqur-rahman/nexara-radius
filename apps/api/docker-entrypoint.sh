#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Nexara API — Docker entrypoint
#
# 1. Applies pending Prisma migrations (idempotent — safe every start)
# 2. On first boot (no admin user yet), seeds bootstrap data from
#    prisma/seed.config.json (falls back to seed.config.json.example)
# 3. Starts the API server
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "[entrypoint] Ensuring migration tracking table exists..."
node node_modules/prisma/build/index.js db execute \
  --file ./prisma/ensure-migrations-table.sql
echo "[entrypoint] Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy
echo "[entrypoint] Migrations done."

# If a host bind-mount turned seed.config.json into a directory (file was
# missing at first `docker compose up`), clear it so the baked-in example works.
SEED_CFG=./prisma/seed.config.json
if [ -d "$SEED_CFG" ]; then
  echo "[entrypoint] WARNING: $SEED_CFG is a directory (bad bind mount)."
  echo "[entrypoint] Removing it so baked-in seed.config.json.example can be used."
  rmdir "$SEED_CFG" 2>/dev/null || rm -rf "$SEED_CFG"
fi

if [ ! -f "$SEED_CFG" ] && [ -f ./prisma/seed.config.json.example ]; then
  echo "[entrypoint] No seed.config.json — copying defaults from example."
  cp ./prisma/seed.config.json.example "$SEED_CFG"
fi

echo "[entrypoint] Checking whether bootstrap seed is needed..."
NEED_SEED="$(node --input-type=module <<'EOF'
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
try {
  const admins = await prisma.user.count({ where: { role: "admin" } });
  process.stdout.write(admins === 0 ? "yes" : "no");
} finally {
  await prisma.$disconnect();
}
EOF
)"

if [ "$NEED_SEED" = "yes" ]; then
  echo "[entrypoint] No admin user found — running first-boot seed..."
  node --openssl-legacy-provider prisma/seed.mjs
  echo "[entrypoint] First-boot seed complete."
else
  echo "[entrypoint] Admin already exists — skipping full seed."
  echo "[entrypoint] Ensuring open lab NAS (0.0.0.0/0) exists for web management..."
  node --openssl-legacy-provider prisma/ensure-open-nas.mjs
fi

echo "[entrypoint] Starting API server..."
exec "$@"
