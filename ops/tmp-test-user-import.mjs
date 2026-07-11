#!/usr/bin/env node
/**
 * Smoke-test user CSV export/import (with devices) against the local API container.
 * Usage: node ops/tmp-test-user-import.mjs
 */
import { writeFileSync } from "node:fs";

const API = process.env.API_BASE || "http://127.0.0.1:8123/api/v1";
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

async function main() {
  console.log("API:", API);
  console.log("1) Login...");
  const login = await json("/auth/login", {
    method: "POST",
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  assert(login.accessToken, "no access token");
  const token = login.accessToken;
  console.log("   OK as", login.user?.username);

  console.log("2) Download import template...");
  const tplRes = await fetch(`${API}/admin/users/import/template`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(tplRes.ok, `template ${tplRes.status}`);
  const template = await tplRes.text();
  assert(template.includes("devices"), "template missing devices column");
  assert(template.includes("username"), "template missing username");
  console.log("   OK template bytes", template.length);

  const stamp = Date.now().toString(36);
  const userA = `imp_${stamp}_a`;
  const userB = `imp_${stamp}_b`;
  const mac1 = "aa:bb:cc:dd:ee:01";
  const mac2 = "aa:bb:cc:dd:ee:02";
  const mac3 = "aa:bb:cc:dd:ee:03";

  const csv = [
    "username,email,fullName,password,role,status,group,certEnabled,validFrom,validUntil,devices",
    `${userA},${userA}@example.local,Import A,ImportPass123!,user,active,Guest,true,,,*${mac1}|Phone A|approved;${mac2}|Laptop A|pending`,
    `${userB},${userB}@example.local,Import B,ImportPass123!,user,active,Family,true,,,${mac3}|Tablet B|approved`,
  ].join("\r\n") + "\r\n";

  writeFileSync("/tmp/tmp-import-sample.csv", csv);

  console.log("3) Dry-run import...");
  const dry = await json("/admin/users/import", {
    method: "POST",
    token,
    body: { csv, mode: "create", dryRun: true },
  });
  assert(dry.created === 2, `dry created expected 2 got ${dry.created}`);
  assert(dry.failed === 0, `dry failed ${dry.failed}: ${JSON.stringify(dry.rows)}`);
  assert(dry.devicesCreated === 3, `dry devicesCreated expected 3 got ${dry.devicesCreated}`);
  console.log("   OK dry-run", { created: dry.created, devicesCreated: dry.devicesCreated });

  console.log("4) Real import (create)...");
  const created = await json("/admin/users/import", {
    method: "POST",
    token,
    body: { csv, mode: "create", dryRun: false },
  });
  assert(created.created === 2, `created expected 2 got ${created.created}`);
  assert(created.failed === 0, `create failed: ${JSON.stringify(created.rows)}`);
  assert(created.devicesCreated === 3, `devicesCreated expected 3 got ${created.devicesCreated}`);
  console.log("   OK create", created.rows.map((r) => r.message));

  console.log("5) Re-import create-only should skip...");
  const skipped = await json("/admin/users/import", {
    method: "POST",
    token,
    body: { csv, mode: "create", dryRun: false },
  });
  assert(skipped.skipped === 2, `skipped expected 2 got ${skipped.skipped}`);
  console.log("   OK skipped", skipped.skipped);

  console.log("6) Upsert with device update...");
  const csvUpsert = [
    "username,email,fullName,password,role,status,group,certEnabled,validFrom,validUntil,devices",
    `${userA},${userA}@example.local,Import A Updated,,user,active,Guest,true,,,*${mac1}|Phone A Renamed|approved;${mac2}|Laptop A|approved`,
  ].join("\r\n") + "\r\n";
  const upserted = await json("/admin/users/import", {
    method: "POST",
    token,
    body: { csv: csvUpsert, mode: "upsert", dryRun: false },
  });
  assert(upserted.updated === 1, `updated expected 1 got ${upserted.updated}`);
  assert(upserted.failed === 0, `upsert failed: ${JSON.stringify(upserted.rows)}`);
  assert(upserted.devicesUpdated >= 1, `devicesUpdated expected >=1 got ${upserted.devicesUpdated}`);
  console.log("   OK upsert", upserted.rows[0], { devicesUpdated: upserted.devicesUpdated });

  console.log("7) Export CSV includes devices...");
  const expRes = await fetch(`${API}/admin/users/export?q=${encodeURIComponent(userA)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(expRes.ok, `export ${expRes.status}`);
  const exported = await expRes.text();
  assert(exported.includes("devices"), "export missing devices header");
  assert(exported.includes(userA), "export missing imported user");
  assert(exported.toLowerCase().includes(mac1), `export missing mac ${mac1}`);
  assert(exported.includes("Phone A Renamed") || exported.includes("Phone A"), "export missing device label");
  assert(!/,[^,\n]{10,},[^,\n]*ImportPass/.test(exported.split("\n").find((l) => l.includes(userA)) || ""), "password leaked?");
  // password column should be empty for exported user row
  const userLine = exported.split(/\r?\n/).find((l) => l.startsWith(userA + ",") || l.includes(`,` + userA + `@`) || l.startsWith(userA));
  assert(userLine, "could not find user line in export");
  console.log("   export line:", userLine.slice(0, 180) + "...");
  assert(userLine.includes(",,") || userLine.includes(',"",'), "expected empty password field nearby");

  console.log("8) Verify devices via users list...");
  const listed = await json(`/admin/users?q=${encodeURIComponent(userA)}&pageSize=10`, { token });
  const u = listed.items.find((x) => x.username === userA);
  assert(u, "imported user not in list");
  assert(u.devices?.length >= 2, `expected >=2 devices got ${u.devices?.length}`);
  const phone = u.devices.find((d) => d.mac === mac1);
  assert(phone, "phone device missing");
  assert(phone.status === "approved", `phone status ${phone.status}`);
  console.log("   OK devices", u.devices.map((d) => `${d.mac}:${d.status}:${d.label}`));

  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  process.exit(1);
});
