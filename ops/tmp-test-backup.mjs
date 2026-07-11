#!/usr/bin/env node
/**
 * Smoke-test system backup + restore.
 * Run inside API container: API_BASE=http://127.0.0.1:4000/api/v1 node /tmp/test-backup.js
 */
import { writeFileSync, readFileSync } from "node:fs";

const API = process.env.API_BASE || "http://127.0.0.1:4000/api/v1";
const ADMIN_USER = process.env.ADMIN_USER || "asiq";
const ADMIN_PASS = process.env.ADMIN_PASS || "@Shik";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function json(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

function bufToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function main() {
  console.log("API:", API);
  console.log("1) Login...");
  const login = await json("/auth/login", {
    method: "POST",
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  const token = login.accessToken;
  assert(token, "no token");
  console.log("   OK");

  const markerUser = `bk_${Date.now().toString(36)}`;
  console.log("2) Create marker user", markerUser);
  await json("/admin/users", {
    method: "POST",
    token,
    body: {
      username: markerUser,
      email: `${markerUser}@example.local`,
      fullName: "Backup Marker",
      password: "BackupPass123!",
      role: "user",
      status: "active",
    },
  });

  console.log("3) Download backup (no history)...");
  const res = await fetch(`${API}/admin/backup?includeHistory=false`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(res.ok, `backup download ${res.status}`);
  const gzipBuf = Buffer.from(await res.arrayBuffer());
  assert(gzipBuf[0] === 0x1f && gzipBuf[1] === 0x8b, "not gzip");
  writeFileSync("/tmp/nexara-backup-test.json.gz", gzipBuf);
  console.log("   OK bytes", gzipBuf.length);

  console.log("4) Delete marker user to prove restore...");
  const listed = await json(`/admin/users?q=${markerUser}&pageSize=10`, { token });
  const u = listed.items.find((x) => x.username === markerUser);
  assert(u, "marker missing before delete");
  await json(`/admin/users/${u.id}`, { method: "DELETE", token });
  const listed2 = await json(`/admin/users?q=${markerUser}&pageSize=10`, { token });
  assert(!listed2.items.find((x) => x.username === markerUser), "marker still present");

  console.log("5) Restore backup...");
  const archiveBase64 = bufToB64(readFileSync("/tmp/nexara-backup-test.json.gz"));
  const restored = await json("/admin/backup/restore", {
    method: "POST",
    token,
    body: { confirm: "RESTORE", archiveBase64 },
  });
  assert(restored.ok === true, "restore not ok");
  assert((restored.restored?.users ?? 0) >= 1, "users not restored");
  console.log("   OK restored users", restored.restored.users, "reloaded", restored.reloaded);

  console.log("6) Re-login after restore (sessions may be invalidated)...");
  const login2 = await json("/auth/login", {
    method: "POST",
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  const token2 = login2.accessToken;
  assert(token2, "re-login failed");

  console.log("7) Marker user must exist again...");
  const listed3 = await json(`/admin/users?q=${markerUser}&pageSize=10`, { token: token2 });
  assert(listed3.items.some((x) => x.username === markerUser), "marker not restored");
  console.log("   OK marker restored");

  console.log("8) Reject restore without confirm...");
  let rejected = false;
  try {
    await json("/admin/backup/restore", {
      method: "POST",
      token: token2,
      body: { confirm: "YES", archiveBase64 },
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "expected confirm validation failure");
  console.log("   OK confirm required");

  console.log("\nALL BACKUP CHECKS PASSED");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  process.exit(1);
});
