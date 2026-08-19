#!/usr/bin/env node
/**
 * Delete every tag on the Nexara Docker Hub repos so we can republish
 * from a clean 1.0.0. Uses Docker Hub login from env or docker config.
 *
 *   node ops/docker-hub-delete-tags.mjs
 *   node ops/docker-hub-delete-tags.mjs --tag latest
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USER = process.env.DOCKER_USER ?? "asiqurrahman";
const REPOS = [`${USER}/nexara-api`, `${USER}/nexara-web`, `${USER}/nexara-radius`];

function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

function dockerConfigAuth() {
  const paths = [
    join(homedir(), ".docker", "config.json"),
    "/home/asiq/.docker/config.json",
  ];
  for (const p of paths) {
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      const auths = cfg.auths ?? {};
      const entry =
        auths["https://index.docker.io/v1/"] ??
        auths["https://index.docker.io/v1"] ??
        auths["docker.io"] ??
        auths["https://registry-1.docker.io/v2/"];
      if (!entry?.auth) continue;
      const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 1) continue;
      return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
    } catch {
      // try next
    }
  }
  return null;
}

async function hubToken() {
  const username = process.env.DOCKER_HUB_USERNAME;
  const password = process.env.DOCKER_HUB_TOKEN ?? process.env.DOCKER_HUB_PASSWORD;
  const creds = username && password
    ? { username, password }
    : dockerConfigAuth();
  if (!creds) die("No Docker Hub credentials. docker login first, or set DOCKER_HUB_USERNAME + DOCKER_HUB_TOKEN.");

  const res = await fetch("https://hub.docker.com/v2/users/login/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) die(`Docker Hub login failed (${res.status}).`);
  const body = await res.json();
  if (!body.token) die("Docker Hub login returned no token.");
  return body.token;
}

async function listTags(token, repo) {
  const tags = [];
  let url = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `JWT ${token}` } });
    if (res.status === 404) return [];
    if (!res.ok) die(`List tags failed (${res.status}) for ${repo}.`);
    const body = await res.json();
    for (const row of body.results ?? []) tags.push(row.name);
    url = body.next ?? null;
  }
  return tags;
}

async function deleteTag(token, repo, tag) {
  const res = await fetch(
    `https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(tag)}/`,
    { method: "DELETE", headers: { Authorization: `JWT ${token}` } },
  );
  if (res.status === 204 || res.status === 200 || res.status === 404) return true;
  const text = await res.text();
  die(`Delete ${repo}:${tag} failed (${res.status}) ${text.slice(0, 200)}`);
}

const onlyTag = (() => {
  const i = process.argv.indexOf("--tag");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
})();

const token = await hubToken();
for (const repo of REPOS) {
  const listed = await listTags(token, repo);
  const tags = onlyTag ? listed.filter((t) => t === onlyTag) : listed;
  process.stdout.write(`${repo}: ${listed.length ? listed.join(", ") : "(no tags)"}\n`);
  for (const tag of tags) {
    await deleteTag(token, repo, tag);
    process.stdout.write(`  deleted ${tag}\n`);
  }
  if (onlyTag && !tags.length) process.stdout.write(`  (${onlyTag} not present)\n`);
}
process.stdout.write(onlyTag ? `Removed tag '${onlyTag}' from Nexara Hub repos.\n` : "All Nexara Hub tags removed.\n");
