#!/bin/bash
set -e
echo "=== nginx login ==="
curl -sS -w "\nHTTP:%{http_code}\n" \
  -H "Content-Type: application/json" \
  -d '{"username":"asiq","password":"@Shik"}' \
  http://127.0.0.1:8123/api/v1/auth/login | head -c 500
echo
echo "=== direct API login via container ==="
docker exec nexara-api node --input-type=module <<'EOF'
const r = await fetch("http://127.0.0.1:4000/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "asiq", password: "@Shik" }),
});
console.log("status", r.status);
console.log((await r.text()).slice(0, 300));
EOF
