// ─────────────────────────────────────────────────────────────────────
//  Full-system backup / restore.
//
//  Captures all Prisma app tables + FreeRADIUS SQL tables into a versioned
//  JSON document, gzipped for download. Restore truncates and reloads.
// ─────────────────────────────────────────────────────────────────────
import { gunzipSync, gzipSync } from "node:zlib";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { BadRequest } from "../lib/errors.js";
import { invalidateCaCache } from "../lib/ca.js";
import { reloadFreeRadius } from "../lib/freeradius.js";
import { syncUserToRadius } from "./radiusPolicy.js";

export const BACKUP_FORMAT = "nexara-backup";
export const BACKUP_VERSION = 1;

const RADIUS_TABLES = [
  "nas",
  "radcheck",
  "radreply",
  "radgroupcheck",
  "radgroupreply",
  "radusergroup",
  "radacct",
  "radpostauth",
] as const;

type RadiusTable = (typeof RADIUS_TABLES)[number];

export interface SystemBackupDocument {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  includeHistory: boolean;
  counts: Record<string, number>;
  app: {
    sites: unknown[];
    groups: unknown[];
    groupAttributes: unknown[];
    users: unknown[];
    userSecrets: unknown[];
    userGroups: unknown[];
    userDevices: unknown[];
    nasClients: unknown[];
    platformSettings: unknown[];
    eapCertificates: unknown[];
    userClientCerts: unknown[];
    radiusAllowedIps: unknown[];
    auditLogs: unknown[];
    authEvents: unknown[];
    apiTokens: unknown[];
  };
  radius: Partial<Record<RadiusTable, unknown[]>>;
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      return v;
    }),
  ) as T;
}

async function fetchRadiusTable(table: RadiusTable): Promise<unknown[]> {
  // Table names are from a fixed allowlist — never interpolate user input.
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${table}`);
  return jsonSafe(rows);
}

export async function buildSystemBackup(opts: { includeHistory?: boolean } = {}): Promise<{
  document: SystemBackupDocument;
  gzip: Buffer;
  filename: string;
}> {
  const includeHistory = opts.includeHistory !== false;

  const [
    sites,
    groups,
    groupAttributes,
    users,
    userSecrets,
    userGroups,
    userDevices,
    nasClients,
    platformSettings,
    eapCertificates,
    userClientCerts,
    radiusAllowedIps,
    auditLogs,
    authEvents,
    apiTokens,
  ] = await Promise.all([
    prisma.site.findMany({ orderBy: { name: "asc" } }),
    prisma.group.findMany({ orderBy: { name: "asc" } }),
    prisma.groupAttribute.findMany({ orderBy: { id: "asc" } }),
    prisma.user.findMany({ orderBy: { username: "asc" } }),
    prisma.userSecret.findMany(),
    prisma.userGroup.findMany(),
    prisma.userDevice.findMany({ orderBy: { learnedAt: "asc" } }),
    prisma.nasClient.findMany({ orderBy: { nasname: "asc" } }),
    prisma.platformSetting.findMany({ orderBy: { key: "asc" } }),
    prisma.eapCertificate.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.userClientCert.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.radiusAllowedIp.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.authEvent.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.apiToken.findMany(),
  ]);

  const radius: SystemBackupDocument["radius"] = {
    nas: await fetchRadiusTable("nas"),
    radcheck: await fetchRadiusTable("radcheck"),
    radreply: await fetchRadiusTable("radreply"),
    radgroupcheck: await fetchRadiusTable("radgroupcheck"),
    radgroupreply: await fetchRadiusTable("radgroupreply"),
    radusergroup: await fetchRadiusTable("radusergroup"),
  };
  if (includeHistory) {
    radius.radacct = await fetchRadiusTable("radacct");
    radius.radpostauth = await fetchRadiusTable("radpostauth");
  }

  const document: SystemBackupDocument = jsonSafe({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includeHistory,
    counts: {
      sites: sites.length,
      groups: groups.length,
      groupAttributes: groupAttributes.length,
      users: users.length,
      userSecrets: userSecrets.length,
      userGroups: userGroups.length,
      userDevices: userDevices.length,
      nasClients: nasClients.length,
      platformSettings: platformSettings.length,
      eapCertificates: eapCertificates.length,
      userClientCerts: userClientCerts.length,
      radiusAllowedIps: radiusAllowedIps.length,
      auditLogs: auditLogs.length,
      authEvents: authEvents.length,
      apiTokens: apiTokens.length,
      nas: radius.nas?.length ?? 0,
      radcheck: radius.radcheck?.length ?? 0,
      radreply: radius.radreply?.length ?? 0,
      radgroupcheck: radius.radgroupcheck?.length ?? 0,
      radgroupreply: radius.radgroupreply?.length ?? 0,
      radusergroup: radius.radusergroup?.length ?? 0,
      radacct: radius.radacct?.length ?? 0,
      radpostauth: radius.radpostauth?.length ?? 0,
    },
    app: {
      sites,
      groups,
      groupAttributes,
      users,
      userSecrets,
      userGroups,
      userDevices,
      nasClients,
      platformSettings,
      eapCertificates,
      userClientCerts,
      radiusAllowedIps,
      auditLogs,
      authEvents,
      apiTokens,
    },
    radius,
  });

  const gzip = gzipSync(Buffer.from(JSON.stringify(document), "utf8"), { level: 9 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    document,
    gzip,
    filename: `nexara-backup-${stamp}.json.gz`,
  };
}

export function parseBackupArchive(input: Buffer | string): SystemBackupDocument {
  let buf: Buffer;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      buf = Buffer.from(trimmed, "utf8");
    } else {
      buf = Buffer.from(trimmed, "base64");
    }
  } else {
    buf = input;
  }

  let jsonText: string;
  // gzip magic 1f 8b
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    jsonText = gunzipSync(buf).toString("utf8");
  } else {
    jsonText = buf.toString("utf8");
  }

  let doc: SystemBackupDocument;
  try {
    doc = JSON.parse(jsonText) as SystemBackupDocument;
  } catch {
    throw BadRequest("Backup file is not valid JSON/gzip");
  }

  if (doc.format !== BACKUP_FORMAT) {
    throw BadRequest(`Unsupported backup format (expected ${BACKUP_FORMAT})`);
  }
  if (doc.version !== BACKUP_VERSION) {
    throw BadRequest(`Unsupported backup version ${String(doc.version)} (expected ${BACKUP_VERSION})`);
  }
  if (!doc.app || !doc.radius) {
    throw BadRequest("Backup is missing app/radius sections");
  }
  return doc;
}

function asDate(value: unknown): Date | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw BadRequest(`Invalid date: ${String(value)}`);
    return d;
  }
  throw BadRequest(`Invalid date type: ${typeof value}`);
}

function reviveDates(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) {
    if (k in out) out[k] = asDate(out[k]);
  }
  return out;
}

// JSON backup stores timestamps as ISO strings and INET values as text.
// Prisma $executeRawUnsafe binds those as text, which PostgreSQL will not
// implicitly assign to timestamptz / inet (42804). Cast at the SQL layer.
const RADIUS_TIMESTAMPTZ_COLS = new Set([
  "authdate",
  "acctstarttime",
  "acctupdatetime",
  "acctstoptime",
]);
const RADIUS_INET_COLS = new Set([
  "nasipaddress",
  "framedipaddress",
  "framedipv6address",
  "framedipv6prefix",
  "delegatedipv6prefix",
]);

function radiusPlaceholder(col: string, index: number): string {
  const n = index + 1;
  if (RADIUS_TIMESTAMPTZ_COLS.has(col)) return `$${n}::timestamptz`;
  if (RADIUS_INET_COLS.has(col)) return `$${n}::inet`;
  return `$${n}`;
}

async function insertRadiusRows(table: RadiusTable, rows: unknown[]) {
  if (!rows.length) return;

  const skipCols = new Set(["id", "radacctid"]);

  for (const row of rows) {
    const obj = row as Record<string, unknown>;
    const cols = Object.keys(obj).filter((c) => !skipCols.has(c));
    if (!cols.length) continue;

    const values = cols.map((c) => {
      const v = obj[c];
      // JSON may have stringified numbers / dates from BigInt/Date serialization.
      if (v === null || v === undefined) return null;
      if (typeof v === "number" || typeof v === "boolean") return v;
      if (typeof v === "string") {
        if (v === "") return RADIUS_INET_COLS.has(c) || RADIUS_TIMESTAMPTZ_COLS.has(c) ? null : v;
        // Numeric-looking values for known integer columns
        if (/^-?\d+$/.test(v) && /(?:port|time|count|input|output|session|interim|delay|id)$/i.test(c)) {
          try { return BigInt(v); } catch { return v; }
        }
        return v;
      }
      return v;
    });

    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((c, i) => radiusPlaceholder(c, i)).join(", ");
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`,
      ...values,
    );
  }
}

export interface RestoreResult {
  ok: true;
  restored: Record<string, number>;
  reloaded: boolean;
  reloadError?: string;
  historyError?: string;
  preservedActor?: { username: string; keptPassword: boolean } | null;
  platformAdmin?: string | null;
}

export const PLATFORM_ADMIN_USERNAME = "asiq";

export interface RestoreActor {
  id: string;
  username: string;
}

function asRow(r: unknown): Record<string, unknown> {
  return { ...(r as Record<string, unknown>) };
}

function rowUsername(row: unknown): string {
  return String(asRow(row).username ?? "").toLowerCase();
}

function rewriteFk(rows: unknown[], field: string, map: Map<string, string>): unknown[] {
  if (!map.size) return rows;
  return rows.map((r) => {
    const row = asRow(r);
    const cur = row[field];
    if (typeof cur === "string" && map.has(cur)) row[field] = map.get(cur)!;
    return row;
  });
}

async function snapshotActor(actor?: RestoreActor) {
  if (!actor) return null;
  const byId = await prisma.user.findUnique({
    where: { id: actor.id },
    include: { secret: true },
  });
  if (byId) return byId;
  return prisma.user.findUnique({
    where: { username: actor.username.toLowerCase() },
    include: { secret: true },
  });
}

/**
 * Keep the signed-in operator (matched by username) so restore cannot
 * lock them out, and force `asiq` to platform admin.
 */
function guardRestoreApp(
  app: SystemBackupDocument["app"],
  live: NonNullable<Awaited<ReturnType<typeof snapshotActor>>>,
): {
  app: SystemBackupDocument["app"];
  preservedActor: { username: string; keptPassword: boolean };
  platformAdmin: string | null;
} {
  const actorName = live.username.toLowerCase();
  const idMap = new Map<string, string>();

  const backupActor = app.users.find((u) => rowUsername(u) === actorName);
  if (backupActor) {
    const backupId = String(asRow(backupActor).id ?? "");
    if (backupId && backupId !== live.id) idMap.set(backupId, live.id);
  }

  let users: unknown[] = rewriteFk(app.users, "id", idMap);
  users = users.map((u) => {
    const row = asRow(u);
    const name = String(row.username ?? "").toLowerCase();
    if (name === PLATFORM_ADMIN_USERNAME || name === actorName) {
      row.role = "admin";
      row.status = "active";
    }
    if (name === actorName) {
      row.id = live.id;
      row.username = live.username;
      row.mfaEnabled = live.mfaEnabled;
      row.mfaSecret = live.mfaSecret;
    }
    return row;
  });

  if (!backupActor) {
    users.push({
      id: live.id,
      username: live.username,
      email: live.email,
      phone: live.phone,
      fullName: live.fullName,
      role: "admin",
      status: "active",
      validFrom: live.validFrom?.toISOString() ?? null,
      validUntil: live.validUntil?.toISOString() ?? null,
      mfaEnabled: live.mfaEnabled,
      mfaSecret: live.mfaSecret,
      certEnabled: live.certEnabled,
      lastLoginAt: live.lastLoginAt?.toISOString() ?? null,
      createdAt: live.createdAt.toISOString(),
      updatedAt: live.updatedAt.toISOString(),
    });
  }

  let userSecrets = rewriteFk(app.userSecrets, "userId", idMap);
  const secretIdx = userSecrets.findIndex((s) => asRow(s).userId === live.id);
  if (live.secret) {
    const kept = {
      userId: live.id,
      passwordHashArgon2id: live.secret.passwordHashArgon2id,
      ntHash: live.secret.ntHash,
      passwordChangedAt: live.secret.passwordChangedAt.toISOString(),
      mustChangePassword: live.secret.mustChangePassword,
      tokenVersion: live.secret.tokenVersion,
      failedAttempts: live.secret.failedAttempts,
      lockedUntil: live.secret.lockedUntil?.toISOString() ?? null,
    };
    if (secretIdx >= 0) userSecrets[secretIdx] = kept;
    else userSecrets.push(kept);
  }

  const guarded: SystemBackupDocument["app"] = {
    ...app,
    users,
    userSecrets,
    userGroups: rewriteFk(app.userGroups, "userId", idMap),
    userDevices: rewriteFk(app.userDevices, "userId", idMap),
    userClientCerts: rewriteFk(app.userClientCerts, "userId", idMap),
    auditLogs: rewriteFk(app.auditLogs, "actorId", idMap),
    authEvents: rewriteFk(app.authEvents, "userId", idMap),
    apiTokens: rewriteFk(app.apiTokens, "userId", idMap),
  };

  const platformAdmin = users.some((u) => rowUsername(u) === PLATFORM_ADMIN_USERNAME)
    ? PLATFORM_ADMIN_USERNAME
    : null;

  return {
    app: guarded,
    preservedActor: { username: live.username, keptPassword: Boolean(live.secret) },
    platformAdmin,
  };
}

function forcePlatformAdmin(app: SystemBackupDocument["app"]): SystemBackupDocument["app"] {
  return {
    ...app,
    users: app.users.map((u) => {
      const row = asRow(u);
      if (String(row.username ?? "").toLowerCase() === PLATFORM_ADMIN_USERNAME) {
        row.role = "admin";
        row.status = "active";
      }
      return row;
    }),
  };
}

export async function restoreSystemBackup(
  doc: SystemBackupDocument,
  opts: { actor?: RestoreActor } = {},
): Promise<RestoreResult> {
  const live = await snapshotActor(opts.actor);
  let preservedActor: RestoreResult["preservedActor"] = null;
  let platformAdmin: string | null = null;
  let app = doc.app;

  if (live) {
    const guarded = guardRestoreApp(app, live);
    app = guarded.app;
    preservedActor = guarded.preservedActor;
    platformAdmin = guarded.platformAdmin;
  } else {
    app = forcePlatformAdmin(app);
    platformAdmin = app.users.some((u) => rowUsername(u) === PLATFORM_ADMIN_USERNAME)
      ? PLATFORM_ADMIN_USERNAME
      : null;
  }

  const radius = doc.radius;

  // App tables are owned by app_user (TRUNCATE ok). FreeRADIUS tables only
  // have DML grants (DELETE, not TRUNCATE) — clear them separately.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "audit_logs",
      "auth_events",
      "user_client_certs",
      "user_devices",
      "user_groups",
      "user_secrets",
      "api_tokens",
      "users",
      "group_attributes",
      "groups",
      "nas_clients",
      "sites",
      "eap_certificates",
      "radius_allowed_ips",
      "platform_settings"
    RESTART IDENTITY CASCADE
  `);

  for (const table of RADIUS_TABLES) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }

  // Sites / groups first
  if (app.sites.length) {
    await prisma.site.createMany({
      data: app.sites.map((r) => r as Prisma.SiteCreateManyInput),
    });
  }
  if (app.groups.length) {
    await prisma.group.createMany({
      data: app.groups.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["createdAt", "updatedAt"]);
        return row as unknown as Prisma.GroupCreateManyInput;
      }),
    });
  }
  if (app.groupAttributes.length) {
    await prisma.groupAttribute.createMany({
      data: app.groupAttributes.map((r) => r as Prisma.GroupAttributeCreateManyInput),
    });
  }

  if (app.users.length) {
    await prisma.user.createMany({
      data: app.users.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, [
          "validFrom",
          "validUntil",
          "lastLoginAt",
          "createdAt",
          "updatedAt",
        ]);
        return row as unknown as Prisma.UserCreateManyInput;
      }),
    });
  }
  if (app.userSecrets.length) {
    await prisma.userSecret.createMany({
      data: app.userSecrets.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["passwordChangedAt", "lockedUntil"]);
        return row as unknown as Prisma.UserSecretCreateManyInput;
      }),
    });
  }
  if (app.userGroups.length) {
    await prisma.userGroup.createMany({
      data: app.userGroups.map((r) => r as Prisma.UserGroupCreateManyInput),
    });
  }
  if (app.userDevices.length) {
    await prisma.userDevice.createMany({
      data: app.userDevices.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, [
          "learnedAt",
          "verifiedAt",
          "lastSeenAt",
          "decidedAt",
        ]);
        // BigInt telegram fields may arrive as strings
        if (typeof row.telegramChatId === "string" && row.telegramChatId !== "") {
          row.telegramChatId = BigInt(row.telegramChatId);
        } else if (row.telegramChatId === "" || row.telegramChatId === null) {
          row.telegramChatId = null;
        }
        return row as unknown as Prisma.UserDeviceCreateManyInput;
      }),
    });
  }
  if (app.nasClients.length) {
    await prisma.nasClient.createMany({
      data: app.nasClients.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["createdAt", "updatedAt"]);
        return row as unknown as Prisma.NasClientCreateManyInput;
      }),
    });
  }
  if (app.platformSettings.length) {
    await prisma.platformSetting.createMany({
      data: app.platformSettings.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["updatedAt"]);
        return row as unknown as Prisma.PlatformSettingCreateManyInput;
      }),
    });
  }
  if (app.eapCertificates.length) {
    await prisma.eapCertificate.createMany({
      data: app.eapCertificates.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, [
          "issuedAt",
          "expiresAt",
          "createdAt",
          "updatedAt",
        ]);
        return row as unknown as Prisma.EapCertificateCreateManyInput;
      }),
    });
  }
  if (app.userClientCerts.length) {
    await prisma.userClientCert.createMany({
      data: app.userClientCerts.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["expiresAt", "createdAt"]);
        return row as unknown as Prisma.UserClientCertCreateManyInput;
      }),
    });
  }
  if (app.radiusAllowedIps.length) {
    await prisma.radiusAllowedIp.createMany({
      data: app.radiusAllowedIps.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["createdAt"]);
        return row as unknown as Prisma.RadiusAllowedIpCreateManyInput;
      }),
    });
  }
  if (app.auditLogs.length) {
    await prisma.auditLog.createMany({
      data: app.auditLogs.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["createdAt"]);
        return row as unknown as Prisma.AuditLogCreateManyInput;
      }),
    });
  }
  if (app.authEvents.length) {
    await prisma.authEvent.createMany({
      data: app.authEvents.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["createdAt"]);
        return row as unknown as Prisma.AuthEventCreateManyInput;
      }),
    });
  }
  if (app.apiTokens.length) {
    await prisma.apiToken.createMany({
      data: app.apiTokens.map((r) => {
        const row = reviveDates(r as Record<string, unknown>, ["createdAt", "lastUsedAt", "expiresAt"]);
        return row as unknown as Prisma.ApiTokenCreateManyInput;
      }),
    });
  }

  const radiusFailed = new Set<string>();
  let historyError: string | undefined;
  for (const table of RADIUS_TABLES) {
    const rows = radius[table];
    if (!rows?.length) continue;
    try {
      await insertRadiusRows(table, rows);
    } catch (err) {
      radiusFailed.add(table);
      const msg = err instanceof Error ? err.message : String(err);
      historyError = [historyError, `${table}: ${msg.split("\n")[0]}`].filter(Boolean).join("; ");
    }
  }

  if (live) {
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await syncUserToRadius(tx, live.id);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      historyError = [historyError, `radius-sync: ${msg.split("\n")[0]}`].filter(Boolean).join("; ");
    }
  }

  invalidateCaCache();

  let reloaded = false;
  let reloadError: string | undefined;
  try {
    const reload = await reloadFreeRadius();
    reloaded = Boolean(reload.triggered && reload.success);
    if (reload.triggered && !reload.success) reloadError = reload.error ?? "reload failed";
  } catch (err) {
    reloadError = err instanceof Error ? err.message : String(err);
  }

  const restored: Record<string, number> = {
    sites: app.sites.length,
    groups: app.groups.length,
    groupAttributes: app.groupAttributes.length,
    users: app.users.length,
    userSecrets: app.userSecrets.length,
    userGroups: app.userGroups.length,
    userDevices: app.userDevices.length,
    nasClients: app.nasClients.length,
    platformSettings: app.platformSettings.length,
    eapCertificates: app.eapCertificates.length,
    userClientCerts: app.userClientCerts.length,
    radiusAllowedIps: app.radiusAllowedIps.length,
    auditLogs: app.auditLogs.length,
    authEvents: app.authEvents.length,
    apiTokens: app.apiTokens.length,
  };
  for (const table of RADIUS_TABLES) {
    restored[table] = radiusFailed.has(table) ? 0 : (radius[table]?.length ?? 0);
  }

  return { ok: true, restored, reloaded, reloadError, historyError, preservedActor, platformAdmin };
}
