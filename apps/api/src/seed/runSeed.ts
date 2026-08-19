import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { hashPassword, ntHash } from "../lib/password.js";
import { saveReloadCommand, getReloadCommand, reloadFreeRadius } from "../lib/freeradius.js";
import { syncGroupToRadius, syncNasToRadius, syncUserToRadius } from "../services/radiusPolicy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prismaDir = resolve(__dirname, "../../prisma");

function loadSeedConfig() {
  const primary = resolve(prismaDir, "seed.config.json");
  const fallback = resolve(prismaDir, "seed.config.json.example");
  const path =
    existsSync(primary) && statSync(primary).isFile() ? primary
    : existsSync(fallback) && statSync(fallback).isFile() ? fallback
    : null;
  if (!path) {
    throw new Error(
      `Seed config not found. Expected a file at ${primary} or ${fallback}.`
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const seedConfig = loadSeedConfig();

const prisma = new PrismaClient();

function writeSeedLine(message: string) {
  process.stdout.write(`${message}\n`);
}

export async function runSeed() {
  // ── Default RADIUS policy groups ────────────────────────────────────────
  //
  // Only two groups are seeded.  Admins can create additional groups freely
  // via the Groups & Policy view — groups are fully dynamic.
  //
  // Guest (isDefault: true)
  //   New users start here automatically.  Add attributes such as
  //   Session-Timeout or bandwidth limits to restrict guest access.
  //
  // Family
  //   Full-access group for household members.  Admin assigns manually.
  //   Add reply attributes (e.g. Tunnel-Type, VLAN) for network separation.
  //
  // Sessions are unlimited on both groups by default — add Session-Timeout
  // via the group attribute editor, or use User.validUntil for per-user expiry.

  const guest = await prisma.group.upsert({
    where: { name: "Guest" },
    update: { description: "Guest / visitor WiFi access", isDefault: true },
    create: {
      name: "Guest",
      description: "Guest / visitor WiFi access",
      isDefault: true,
    },
  });

  const family = await prisma.group.upsert({
    where: { name: "Family" },
    update: { description: "Family / household members — full access", isDefault: false },
    create: {
      name: "Family",
      description: "Family / household members — full access",
      isDefault: false,
    },
  });

  const { username: adminUsername, password: adminPassword, email: adminEmail, fullName: adminFullName } = seedConfig.admin;
  const { username: testUsername, password: testPassword, email: testEmail, fullName: testFullName } = seedConfig.testUser;

  // Remove any stale user that holds the same email but a different username
  // (handles the case where the admin username was renamed in seed.config.json)
  await prisma.user.deleteMany({ where: { email: adminEmail, NOT: { username: adminUsername } } });
  await prisma.user.deleteMany({ where: { email: testEmail,  NOT: { username: testUsername  } } });

  const passwordHashArgon2id = await hashPassword(adminPassword);
  const nthash = ntHash(adminPassword);
  const testPasswordHash = await hashPassword(testPassword);
  const testNtHash = ntHash(testPassword);

  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {
      email: adminEmail,
      fullName: adminFullName,
      secret: {
        update: {
          passwordHashArgon2id,
          ntHash: nthash,
        },
      },
    },
    create: {
      username: adminUsername,
      email: adminEmail,
      fullName: adminFullName,
      role: "admin",
      status: "active",
      secret: {
        create: {
          passwordHashArgon2id,
          ntHash: nthash,
          mustChangePassword: true,
        },
      },
      groups: {
        create: { groupId: family.id, priority: 1 },
      },
    },
  });

  const testUser = await prisma.user.upsert({
    where: { username: testUsername },
    update: {
      email: testEmail,
      fullName: testFullName,
      secret: {
        update: {
          passwordHashArgon2id: testPasswordHash,
          ntHash: testNtHash,
        },
      },
    },
    create: {
      username: testUsername,
      email: testEmail,
      fullName: testFullName,
      role: "user",
      status: "active",
      secret: {
        create: {
          passwordHashArgon2id: testPasswordHash,
          ntHash: testNtHash,
          mustChangePassword: false,
        },
      },
      groups: {
        create: { groupId: family.id, priority: 1 },
      },
    },
  });

  // Default open lab NAS (0.0.0.0/0) so it appears in Admin → NAS and can
  // be disabled / edited / deleted from the web UI. Override via seed.config.json.
  const nasIp = seedConfig.nas.ip?.trim() || "0.0.0.0/0";
  const nas = await prisma.nasClient.upsert({
    where: { nasname: nasIp },
    update: {
      shortname: seedConfig.nas.shortname || "any",
      secret: seedConfig.nas.secret || "testing123",
      type: seedConfig.nas.vendor || "other",
      enabled: true,
      coaPort: seedConfig.nas.coaPort ?? 3799,
      description:
        seedConfig.nas.description ||
        "Open lab client (any IP) — disable or delete after adding real APs",
    },
    create: {
      nasname: nasIp,
      shortname: seedConfig.nas.shortname || "any",
      secret: seedConfig.nas.secret || "testing123",
      type: seedConfig.nas.vendor || "other",
      enabled: true,
      coaPort: seedConfig.nas.coaPort ?? 3799,
      description:
        seedConfig.nas.description ||
        "Open lab client (any IP) — disable or delete after adding real APs",
    },
  });

  await prisma.$transaction(async (tx) => {
    await syncGroupToRadius(tx, guest.id);
    await syncGroupToRadius(tx, family.id);
    await syncUserToRadius(tx, admin.id);
    await syncUserToRadius(tx, testUser.id);
    await syncNasToRadius(tx, nas.id);
  });

  // Ensure web Settings shows a reload command for Docker deployments when unset.
  if (!(await getReloadCommand())) {
    await saveReloadCommand("docker kill -s HUP nexara-radius");
  }
  await reloadFreeRadius();

  writeSeedLine("Seed complete.");
  writeSeedLine(`  Admin    : ${adminUsername} / ${adminPassword}  (change on first login)`);
  writeSeedLine(`  Test user: ${testUsername} / ${testPassword}`);
  writeSeedLine(`  NAS      : ${nas.nasname} / secret ${nas.secret} / CoA ${nas.coaPort}`);
}

export async function runSeedWithCleanup() {
  try {
    await runSeed();
  } finally {
    await prisma.$disconnect();
  }
}

/** Create the open lab NAS once if the NAS list is empty.
 *  Does not revive a disabled row. Does not recreate if any NAS already exists
 *  (so delete sticks after you add real APs, or if you leave the list empty
 *  intentionally after disabling — disable is preferred over delete). */
export async function ensureOpenNasIfMissing() {
  const nasIp = seedConfig.nas?.ip?.trim() || "0.0.0.0/0";
  const existing = await prisma.nasClient.findUnique({ where: { nasname: nasIp } });
  if (existing) return existing;

  const otherNas = await prisma.nasClient.count();
  if (otherNas > 0) return null;

  const nas = await prisma.nasClient.create({
    data: {
      nasname: nasIp,
      shortname: seedConfig.nas?.shortname || "any",
      secret: seedConfig.nas?.secret || "testing123",
      type: seedConfig.nas?.vendor || "other",
      enabled: true,
      coaPort: seedConfig.nas?.coaPort ?? 3799,
      description:
        seedConfig.nas?.description ||
        "Open lab client (any IP) — disable or delete after adding real APs",
    },
  });
  await prisma.$transaction(async (tx) => {
    await syncNasToRadius(tx, nas.id);
  });
  writeSeedLine(`Open NAS ensured: ${nas.nasname} / secret ${nas.secret}`);
  if (!(await getReloadCommand())) {
    await saveReloadCommand("docker kill -s HUP nexara-radius");
  }
  await reloadFreeRadius();
  return nas;
}

export async function ensureOpenNasIfMissingWithCleanup() {
  try {
    return await ensureOpenNasIfMissing();
  } finally {
    await prisma.$disconnect();
  }
}

