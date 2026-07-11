#!/bin/bash
set -e
cd /mnt/d/RnD/Freeradius

echo "Waiting for API healthy..."
i=1
while [ "$i" -le 40 ]; do
  status=$(docker inspect -f '{{.State.Health.Status}}' nexara-api 2>/dev/null || echo none)
  echo "  attempt $i: $status"
  if [ "$status" = "healthy" ]; then break; fi
  i=$((i+1))
  sleep 3
done

docker cp ops/tmp-test-backup.mjs nexara-api:/tmp/test-backup.mjs
docker exec -e API_BASE=http://127.0.0.1:4000/api/v1 nexara-api node /tmp/test-backup.mjs
