// ─────────────────────────────────────────────────────────────────────
//  Admin: RADIUS access-reject log.
//
//  Queries radpostauth (written by FreeRADIUS) for every Access-Reject
//  entry and enriches with user + device context from the app tables.
//
//  Passwords are NEVER returned — logging failed passwords is a
//  security risk (typos often contain real passwords from other creds).
// ─────────────────────────────────────────────────────────────────────

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import type { RejectLogEntry } from "@app/shared";

const ListQuery = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  search:   z.string().trim().max(120).optional(),
});

// Normalise MAC to lowercase colon-separated for matching against user_devices
function normaliseMac(raw: string | null): string | null {
  if (!raw) return null;
  // Called-Station-Id can be "AA-BB-CC-DD-EE-FF:SSID" — take the MAC part only
  const macPart = raw.split(":").length > 2 ? raw : raw.split(":")[0] ?? raw;
  return macPart
    .replace(/[:\-\.]/g, "")
    .toLowerCase()
    .replace(/(.{2})(?=.)/g, "$1:")
    .slice(0, 17);
}

function normalizeClass(raw: string | null): string {
  if (!raw) return "";
  let value = raw.trim().toLowerCase().replace(/^"+|"+$/g, "");
  // FreeRADIUS sometimes stores Class as hex octets: \x756e72...
  if (/^\\x[0-9a-f]+$/i.test(value) || /^[0-9a-f]{16,}$/.test(value)) {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    try {
      value = Buffer.from(hex, "hex").toString("utf8").trim().toLowerCase();
    } catch {
      // keep original
    }
  }
  return value;
}

function deriveReason(
  storedClass:  string | null,
  reply:        string,
  userExists:   boolean,
  deviceStatus: string | null,
  hasMac:       boolean,
): string {
  const code = normalizeClass(storedClass);
  if (code.includes("unregistered-device") || code === "unregistered") return "Unregistered device";
  if (code.includes("device-pending") || code === "pending") return "Device pending approval";
  if (code.includes("device-rejected")) return "Device rejected by admin";
  if (code.includes("device-blocked"))  return "Device permanently blocked";
  if (code.includes("unknown-username")) return "Unknown username";
  if (code.includes("account-expired")) return "Account expired";
  if (code.includes("account-inactive")) return "Account inactive";
  if (!userExists) return "Unknown username";
  if (code.includes("wrong-password")) return "Wrong password";
  if (deviceStatus === "blocked")  return "Device permanently blocked";
  if (deviceStatus === "rejected") return "Device rejected by admin";
  if (deviceStatus === "pending")  return "Device pending approval";
  if (deviceStatus === null && hasMac) return "Unregistered device";
  if (deviceStatus === "approved") return "Wrong password";
  if (!hasMac) return "Wrong password";

  return reply || "Access-Reject";
}

const adminRejectLog: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.authorize(["admin"]));

  // DELETE /admin/reject-log — wipe all Access-Reject entries from radpostauth
  app.delete("/reject-log", async () => {
    const result = await prisma.$executeRawUnsafe(
      `DELETE FROM radpostauth WHERE reply ILIKE '%reject%'`,
    );
    return { ok: true, deleted: result };
  });

  app.get("/reject-log", async (req) => {
    const query = ListQuery.parse(req.query);
    const offset = (query.page - 1) * query.pageSize;

    // ── Raw query on radpostauth ─────────────────────────────────────
    // Pass field is deliberately excluded — never log passwords.
    type RawRow = {
      id:              bigint;
      username:        string;
      reply:           string | null;
      callingstationid:string | null;
      calledstationid: string | null;
      authdate:        Date;
      class:           string | null;
    };

    const searchClause = query.search
      ? `AND (lower(rpa.username) LIKE lower($3) OR lower(rpa.callingstationid) LIKE lower($3))`
      : "";
    const searchArg    = query.search ? `%${query.search}%` : undefined;

    const [rows, countResult] = await Promise.all([
      prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT rpa.id, rpa.username, rpa.reply,
                rpa.callingstationid, rpa.calledstationid, rpa.authdate,
                rpa.class
         FROM radpostauth rpa
         WHERE rpa.reply ILIKE '%reject%'
         ${searchClause}
         ORDER BY rpa.authdate DESC
         LIMIT $1 OFFSET $2`,
        query.pageSize,
        offset,
        ...(searchArg ? [searchArg] : []),
      ),
      prisma.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count
         FROM radpostauth rpa
         WHERE rpa.reply ILIKE '%reject%'
         ${searchClause}`,
        ...(searchArg ? [searchArg] : []),
      ),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    // ── Enrich with user + device context ───────────────────────────
    const usernames = [...new Set(rows.map((r) => r.username.toLowerCase()))];
    const macs      = [...new Set(rows.map((r) => normaliseMac(r.callingstationid)).filter(Boolean) as string[])];

    const [users, devices] = await Promise.all([
      usernames.length
        ? prisma.user.findMany({
            where: { username: { in: usernames, mode: "insensitive" } },
            select: { id: true, username: true, fullName: true },
          })
        : [],
      macs.length
        ? prisma.userDevice.findMany({
            where: { mac: { in: macs } },
            select: { id: true, mac: true, userId: true, status: true, label: true },
          })
        : [],
    ]);

    const userMap   = new Map(users.map((u) => [u.username.toLowerCase(), u]));
    const deviceMap = new Map(devices.map((d) => [d.mac, d]));

    const items: RejectLogEntry[] = rows.map((row) => {
      const mac    = normaliseMac(row.callingstationid);
      const user   = userMap.get(row.username.toLowerCase()) ?? null;
      const device = mac ? deviceMap.get(mac) ?? null : null;

      return {
        id:            String(row.id),
        username:      row.username,
        mac:           mac,
        calledStation: row.calledstationid ?? null,
        reply:         row.reply ?? "Access-Reject",
        reason:        deriveReason(row.class, row.reply ?? "", !!user, device?.status ?? null, !!mac),
        authDate:      row.authdate.toISOString(),
        userId:        user?.id ?? null,
        fullName:      user?.fullName ?? null,
        deviceStatus:  device?.status ?? null,
        deviceLabel:   device?.label ?? null,
      };
    });

    return {
      items,
      total,
      page:     query.page,
      pageSize: query.pageSize,
    };
  });
};

export default adminRejectLog;
