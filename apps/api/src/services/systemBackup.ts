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
        // Numeric-looking values for known integer columns
        if (/^-?\d+$/.test(v) && /(?:port|time|count|input|output|session|interim|delay|id)$/i.test(c)) {
          try { return BigInt(v); } catch { return v; }
        }
        return v;
      }
      return v;
    });

    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
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
}

export async function restoreSystemBackup(doc: SystemBackupDocument): Promise<RestoreResult> {
  const app = doc.app;
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

  for (const table of RADIUS_TABLES) {
    const rows = radius[table];
    if (rows?.length) await insertRadiusRows(table, rows);
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
    restored[table] = radius[table]?.length ?? 0;
  }

  return { ok: true, restored, reloaded, reloadError };
}
