// ─────────────────────────────────────────────────────────────────────
//  Admin user CRUD — Phase 1 scope.
//
//  Every write goes through RadiusPolicyService inside a transaction
//  so the app rows and the RADIUS rows can never disagree.
// ─────────────────────────────────────────────────────────────────────
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { hashPassword, ntHash } from "../../lib/password.js";
import { audit } from "../../lib/audit.js";
import { BadRequest, NotFound } from "../../lib/errors.js";
import { changeUserPassword, purgeRadiusUsername, syncUserToRadius } from "../../services/radiusPolicy.js";
import { disconnectForPolicyChange } from "../../services/sessions.js";
import { config } from "../../config.js";
import { assertPasswordNotBreached } from "../../lib/passwordPolicy.js";
import type { Paginated, UserImportResult, UserSummary } from "@app/shared";
import {
  formatDevicesForCsv,
  parseBool,
  parseDevicesField,
  parseOptionalIsoDate,
  parseUserCsv,
  toCsv,
  USER_CSV_TEMPLATE,
  type ParsedDeviceEntry,
} from "../../lib/userCsv.js";
import { normalizeMac } from "../../lib/mac.js";

// ── Schemas ────────────────────────────────────────────────────────

const usernameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9._-]+$/i, "username may only contain letters, digits, dot, underscore, hyphen");

const passwordSchema = z.string().min(10).max(256);

const optionalEmail = z
  .union([z.string().email().max(254), z.literal(""), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return v.toLowerCase();
  });

const optionalPhone = z
  .union([
    z.string().max(32).regex(/^[0-9+\-\s().]*$/, "phone may only contain digits and + - ( ) . spaces"),
    z.literal(""),
    z.null(),
  ])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return v.trim();
  });

const CreateUserBody = z.object({
  username:    usernameSchema,
  email:       optionalEmail,
  phone:       optionalPhone,
  fullName:    z.string().max(120).optional(),
  password:    passwordSchema,
  role:        z.enum(["admin", "user"]).optional(),
  status:      z.enum(["pending", "active"]).optional(),
  certEnabled: z.boolean().optional(),
  groupIds:    z.array(z.string()).max(1, "A user can belong to at most one group").optional(),
  validFrom:   z.string().datetime().nullable().optional(),
  validUntil:  z.string().datetime().nullable().optional(),
});

const UpdateUserBody = z.object({
  username:    usernameSchema.optional(),
  email:       optionalEmail,
  phone:       optionalPhone,
  fullName:    z.string().max(120).nullable().optional(),
  role:        z.enum(["admin", "user"]).optional(),
  status:      z.enum(["pending", "active", "suspended", "expired"]).optional(),
  certEnabled: z.boolean().optional(),
  validFrom:   z.string().datetime().nullable().optional(),
  validUntil:  z.string().datetime().nullable().optional(),
  groupIds:    z.array(z.string()).max(1, "A user can belong to at most one group").optional(),
  newPassword: z.string().min(10).max(256).optional(),
});

const ResetPasswordBody = z.object({
  newPassword: passwordSchema,
  mustChange: z.boolean().optional(),
});

const ListQuery = z.object({
  q: z.string().max(64).optional(),
  status: z.enum(["pending", "active", "suspended", "expired"]).optional(),
  role: z.enum(["admin", "user"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const ImportBody = z.object({
  csv: z.string().min(1).max(2_000_000),
  mode: z.enum(["create", "upsert"]).default("create"),
  dryRun: z.boolean().default(false),
});

// ── Mapping ────────────────────────────────────────────────────────

const include = {
  groups: { include: { group: true } },
  devices: { select: { id: true, mac: true, label: true, status: true, lastSeenAt: true, manufacturer: true } },
} satisfies Prisma.UserInclude;

type UserWithGroups = Prisma.UserGetPayload<{ include: typeof include }>;

function toSummary(u: UserWithGroups): UserSummary {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    fullName: u.fullName,
    role: u.role,
    status: u.status,
    validFrom: u.validFrom?.toISOString() ?? null,
    validUntil: u.validUntil?.toISOString() ?? null,
    mfaEnabled:  u.mfaEnabled,
    certEnabled: u.certEnabled,
    lastLoginAt:     u.lastLoginAt?.toISOString() ?? null,
    ...((): { lastConnectedAt: string | null; lastConnectedMac: string | null } => {
      const latest = u.devices
        .filter((d) => d.lastSeenAt !== null)
        .sort((a, b) => b.lastSeenAt!.getTime() - a.lastSeenAt!.getTime())[0] ?? null;
      return {
        lastConnectedAt:  latest?.lastSeenAt?.toISOString() ?? null,
        lastConnectedMac: latest?.mac ?? null,
      };
    })(),
    createdAt: u.createdAt.toISOString(),
    groups:  u.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
    devices: u.devices.map((d) => ({ id: d.id, mac: d.mac, label: d.label, status: d.status })),
  };
}

async function upsertImportedDevices(
  tx: Prisma.TransactionClient,
  userId: string,
  entries: ParsedDeviceEntry[],
  actorId: string,
  req: Parameters<typeof audit>[0]["req"],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const normalized: Array<ParsedDeviceEntry & { mac: string }> = [];

  for (const entry of entries) {
    const mac = normalizeMac(entry.macRaw);
    if (normalized.some((n) => n.mac === mac)) {
      throw BadRequest(`duplicate MAC ${mac} in devices column`);
    }
    normalized.push({ ...entry, mac });
  }

  if (normalized.some((d) => d.isPrimary)) {
    await tx.userDevice.updateMany({ where: { userId }, data: { isPrimary: false } });
  }

  for (const entry of normalized) {
    const existing = await tx.userDevice.findUnique({
      where: { userId_mac: { userId, mac: entry.mac } },
    });
    if (existing) {
      await tx.userDevice.update({
        where: { id: existing.id },
        data: {
          label: entry.label,
          status: entry.status,
          isPrimary: entry.isPrimary,
          verifiedAt: entry.status === "approved" ? (existing.verifiedAt ?? new Date()) : existing.verifiedAt,
          decidedAt: new Date(),
          decidedBy: actorId,
          decisionNote: "csv_import",
        },
      });
      updated++;
    } else {
      const createdDevice = await tx.userDevice.create({
        data: {
          userId,
          mac: entry.mac,
          label: entry.label,
          status: entry.status,
          isPrimary: entry.isPrimary,
          verifiedAt: entry.status === "approved" ? new Date() : null,
          decidedAt: new Date(),
          decidedBy: actorId,
          decisionNote: "csv_import",
        },
      });
      await audit({
        tx,
        actorId,
        action: "user_update",
        targetType: "device",
        targetId: createdDevice.id,
        metadata: { event: "device.import", mac: entry.mac, status: entry.status },
        req,
      });
      created++;
    }
  }

  return { created, updated };
}

// ── Routes ─────────────────────────────────────────────────────────

const adminUsers: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.authorize(["admin"]));

  // GET /admin/users
  app.get("/users", async (req) => {
    const q = ListQuery.parse(req.query);

    const where: Prisma.UserWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.role) where.role = q.role;
    if (q.q) {
      where.OR = [
        { username: { contains: q.q, mode: "insensitive" } },
        { email: { contains: q.q, mode: "insensitive" } },
        { phone: { contains: q.q, mode: "insensitive" } },
        { fullName: { contains: q.q, mode: "insensitive" } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    const body: Paginated<UserSummary> = {
      items: items.map(toSummary),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    return body;
  });

  // GET /admin/users/export — CSV download (never includes passwords)
  app.get("/users/export", async (req, reply) => {
    const q = ListQuery.omit({ page: true, pageSize: true }).parse(req.query);
    const where: Prisma.UserWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.role) where.role = q.role;
    if (q.q) {
      where.OR = [
        { username: { contains: q.q, mode: "insensitive" } },
        { email: { contains: q.q, mode: "insensitive" } },
        { phone: { contains: q.q, mode: "insensitive" } },
        { fullName: { contains: q.q, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      include: {
        groups: { include: { group: true } },
        devices: {
          select: { mac: true, label: true, status: true, isPrimary: true },
          orderBy: [{ isPrimary: "desc" }, { learnedAt: "asc" }],
        },
      },
      orderBy: { username: "asc" },
      take: 10_000,
    });

    const csv = toCsv(
      users.map((u) => ({
        username: u.username,
        email: u.email ?? "",
        phone: u.phone ?? "",
        fullName: u.fullName ?? "",
        password: "",
        role: u.role,
        status: u.status,
        group: u.groups[0]?.group.name ?? "",
        certEnabled: u.certEnabled ? "true" : "false",
        validFrom: u.validFrom?.toISOString() ?? "",
        validUntil: u.validUntil?.toISOString() ?? "",
        devices: formatDevicesForCsv(u.devices),
      })),
    );

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="nexara-users-${stamp}.csv"`)
      .send(csv);
  });

  // GET /admin/users/import/template
  app.get("/users/import/template", async (_req, reply) => {
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="nexara-users-template.csv"')
      .send(USER_CSV_TEMPLATE);
  });

  // POST /admin/users/import
  app.post("/users/import", async (req) => {
    const body = ImportBody.parse(req.body);
    const actorId = req.currentUser!.sub;

    const { rows, errors: parseErrors } = parseUserCsv(body.csv);
    if (parseErrors.length) throw BadRequest(parseErrors[0]!);
    if (rows.length === 0) throw BadRequest("CSV has no data rows");
    if (rows.length > 1000) throw BadRequest("CSV is limited to 1000 users per import");

    const groups = await prisma.group.findMany({ select: { id: true, name: true } });
    const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));

    const result: UserImportResult = {
      dryRun: body.dryRun,
      mode: body.mode,
      total: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      devicesCreated: 0,
      devicesUpdated: 0,
      rows: [],
    };

    const seenUsernames = new Set<string>();
    const seenEmails = new Set<string>();

    for (const row of rows) {
      const username = row.username.toLowerCase();
      const emailRaw = row.email.trim().toLowerCase();
      const email = emailRaw || null;
      const phoneRaw = row.phone.trim();
      const phone = phoneRaw || null;
      const label = username || email || `line ${row.line}`;

      const fail = (message: string) => {
        result.failed++;
        result.rows.push({ line: row.line, username: label, action: "failed", message });
      };

      if (!username) {
        fail("username is required");
        continue;
      }
      if (!/^[a-z0-9._-]+$/i.test(username) || username.length < 2 || username.length > 64) {
        fail("invalid username");
        continue;
      }
      if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
        fail("invalid email");
        continue;
      }
      if (phone && (phone.length > 32 || !/^[0-9+\-\s().]+$/.test(phone))) {
        fail("invalid phone");
        continue;
      }
      if (seenUsernames.has(username)) {
        fail("duplicate username within this CSV");
        continue;
      }
      if (email && seenEmails.has(email)) {
        fail("duplicate email within this CSV");
        continue;
      }
      seenUsernames.add(username);
      if (email) seenEmails.add(email);

      const roleRaw = (row.role || "user").toLowerCase();
      if (roleRaw !== "admin" && roleRaw !== "user") {
        fail("role must be admin or user");
        continue;
      }
      const role = roleRaw as "admin" | "user";

      const statusRaw = (row.status || "active").toLowerCase();
      const allowedStatus = ["pending", "active", "suspended", "expired"] as const;
      if (!allowedStatus.includes(statusRaw as (typeof allowedStatus)[number])) {
        fail("status must be pending, active, suspended, or expired");
        continue;
      }
      const status = statusRaw as (typeof allowedStatus)[number];

      let groupIds: string[] = [];
      if (row.group.trim()) {
        const g = groupByName.get(row.group.trim().toLowerCase());
        if (!g) {
          fail(`unknown group "${row.group.trim()}"`);
          continue;
        }
        groupIds = [g.id];
      }

      const validFrom = parseOptionalIsoDate(row.validFrom);
      const validUntil = parseOptionalIsoDate(row.validUntil);
      if (validFrom === undefined) {
        fail("invalid validFrom date");
        continue;
      }
      if (validUntil === undefined) {
        fail("invalid validUntil date");
        continue;
      }

      const certEnabled = parseBool(row.certEnabled, true);
      const fullName = row.fullName.trim() || null;

      let deviceEntries: ParsedDeviceEntry[] = [];
      if (row.hasDevicesColumn && row.devices.trim()) {
        const parsedDevices = parseDevicesField(row.devices);
        if (parsedDevices.error) {
          fail(parsedDevices.error);
          continue;
        }
        try {
          for (const entry of parsedDevices.entries) {
            normalizeMac(entry.macRaw); // validate early
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : "invalid device MAC");
          continue;
        }
        deviceEntries = parsedDevices.entries;
      }

      const existing = await prisma.user.findFirst({
        where: email
          ? { OR: [{ username }, { email }] }
          : { username },
      });

      if (!existing) {
        if (!row.password || row.password.length < 10) {
          fail("password required (min 10 chars) for new users");
          continue;
        }
        if (body.dryRun) {
          result.created++;
          result.devicesCreated += deviceEntries.length;
          result.rows.push({
            line: row.line,
            username,
            action: "created",
            message: deviceEntries.length
              ? `would create (+${deviceEntries.length} device${deviceEntries.length === 1 ? "" : "s"})`
              : "would create",
          });
          continue;
        }
        try {
          await assertPasswordNotBreached(row.password);
          const passwordHashArgon2id = await hashPassword(row.password);
          const nthash = ntHash(row.password);
          const createdStatus = status === "pending" || status === "active" ? status : "active";

          const created = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                username,
                email,
                phone,
                fullName,
                role,
                status: createdStatus,
                certEnabled,
                validFrom: validFrom ? new Date(validFrom) : null,
                validUntil: validUntil ? new Date(validUntil) : null,
                secret: {
                  create: { passwordHashArgon2id, ntHash: nthash, mustChangePassword: true },
                },
                groups: groupIds.length
                  ? { create: groupIds.map((gid, i) => ({ groupId: gid, priority: i + 1 })) }
                  : undefined,
              },
              include,
            });
            await syncUserToRadius(tx, user.id);
            const deviceStats = deviceEntries.length
              ? await upsertImportedDevices(tx, user.id, deviceEntries, actorId, req)
              : { created: 0, updated: 0 };
            await audit({
              tx,
              actorId,
              action: "user_create",
              targetType: "user",
              targetId: user.id,
              metadata: {
                username,
                source: "csv_import",
                devices: deviceStats.created,
              },
              req,
            });
            return { user, deviceStats };
          });
          result.created++;
          result.devicesCreated += created.deviceStats.created;
          result.devicesUpdated += created.deviceStats.updated;
          result.rows.push({
            line: row.line,
            username: created.user.username,
            action: "created",
            message: created.deviceStats.created
              ? `created (+${created.deviceStats.created} device${created.deviceStats.created === 1 ? "" : "s"})`
              : "created",
          });
        } catch (err) {
          fail(err instanceof Error ? err.message : "create failed");
        }
        continue;
      }

      if (body.mode === "create") {
        result.skipped++;
        result.rows.push({
          line: row.line,
          username: existing.username,
          action: "skipped",
          message: "already exists",
        });
        continue;
      }

      if (existing.username !== username && email && existing.email === email) {
        fail(`email belongs to different user "${existing.username}"`);
        continue;
      }
      if (email && existing.email !== email) {
        const emailTaken = await prisma.user.findFirst({
          where: { email, NOT: { id: existing.id } },
        });
        if (emailTaken) {
          fail("email already taken by another user");
          continue;
        }
      }

      if (row.password && row.password.length > 0 && row.password.length < 10) {
        fail("password must be at least 10 characters when provided");
        continue;
      }

      if (existing.id === actorId && role === "user" && existing.role === "admin") {
        fail("cannot demote yourself via import");
        continue;
      }
      if (existing.id === actorId && status !== "active") {
        fail("cannot suspend/expire yourself via import");
        continue;
      }

      if (body.dryRun) {
        result.updated++;
        // Approximate device create/update counts for dry-run
        if (deviceEntries.length) {
          const existingDevices = await prisma.userDevice.findMany({
            where: { userId: existing.id },
            select: { mac: true },
          });
          const existingMacs = new Set(existingDevices.map((d) => d.mac));
          for (const entry of deviceEntries) {
            try {
              const mac = normalizeMac(entry.macRaw);
              if (existingMacs.has(mac)) result.devicesUpdated++;
              else result.devicesCreated++;
            } catch {
              /* already validated */
            }
          }
        }
        result.rows.push({
          line: row.line,
          username: existing.username,
          action: "updated",
          message: deviceEntries.length
            ? `would update (+devices ${deviceEntries.length})`
            : "would update",
        });
        continue;
      }

      try {
        if (row.password) await assertPasswordNotBreached(row.password);

        const deviceStats = await prisma.$transaction(async (tx) => {
          if (role === "user" && existing.role === "admin") {
            const otherAdmins = await tx.user.count({
              where: { role: "admin", id: { not: existing.id } },
            });
            if (otherAdmins === 0) {
              throw BadRequest("Cannot demote the last admin");
            }
          }

          await tx.user.update({
            where: { id: existing.id },
            data: {
              email,
              phone,
              fullName,
              role,
              status,
              certEnabled,
              validFrom: validFrom ? new Date(validFrom) : null,
              validUntil: validUntil ? new Date(validUntil) : null,
            },
          });

          await tx.userGroup.deleteMany({ where: { userId: existing.id } });
          if (groupIds.length) {
            await tx.userGroup.createMany({
              data: groupIds.map((gid, i) => ({
                userId: existing.id,
                groupId: gid,
                priority: i + 1,
              })),
            });
          }

          await syncUserToRadius(tx, existing.id);

          const stats = deviceEntries.length
            ? await upsertImportedDevices(tx, existing.id, deviceEntries, actorId, req)
            : { created: 0, updated: 0 };

          await audit({
            tx,
            actorId,
            action: "user_update",
            targetType: "user",
            targetId: existing.id,
            metadata: {
              username: existing.username,
              source: "csv_import",
              devicesCreated: stats.created,
              devicesUpdated: stats.updated,
            },
            req,
          });
          return stats;
        });

        result.devicesCreated += deviceStats.created;
        result.devicesUpdated += deviceStats.updated;

        if (row.password) {
          await changeUserPassword({
            userId: existing.id,
            newPassword: row.password,
            actorId,
            mustChange: false,
            req,
          });
        }

        result.updated++;
        const deviceMsg =
          deviceStats.created || deviceStats.updated
            ? ` (devices +${deviceStats.created}/~${deviceStats.updated})`
            : "";
        result.rows.push({
          line: row.line,
          username: existing.username,
          action: "updated",
          message: (row.password ? "updated (password changed)" : "updated") + deviceMsg,
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : "update failed");
      }
    }

    return result;
  });

  // GET /admin/users/:id
  app.get<{ Params: { id: string } }>("/users/:id", async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, include });
    if (!user) throw NotFound("User not found");
    return toSummary(user);
  });

  // POST /admin/users
  app.post("/users", async (req) => {
    const body = CreateUserBody.parse(req.body);
    const actorId = req.currentUser!.sub;

    await assertPasswordNotBreached(body.password);
    const passwordHashArgon2id = await hashPassword(body.password);
    const nthash = ntHash(body.password);

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: body.username.toLowerCase(),
          email: body.email ?? null,
          phone: body.phone ?? null,
          fullName: body.fullName,
          role:        body.role ?? "user",
          status:      body.status ?? "active",
          certEnabled: body.certEnabled ?? false,
          validFrom:   body.validFrom  ? new Date(body.validFrom)  : null,
          validUntil:  body.validUntil ? new Date(body.validUntil) : null,
          secret: {
            create: { passwordHashArgon2id, ntHash: nthash, mustChangePassword: true },
          },
          groups: body.groupIds
            ? { create: body.groupIds.map((gid, i) => ({ groupId: gid, priority: i + 1 })) }
            : undefined,
        },
        include,
      });

      await syncUserToRadius(tx, user.id);
      await audit({
        tx,
        actorId,
        action: "user_create",
        targetType: "user",
        targetId: user.id,
        metadata: { username: user.username, role: user.role },
        req,
      });
      return user;
    });

    return toSummary(created);
  });

  // PATCH /admin/users/:id
  app.patch<{ Params: { id: string } }>("/users/:id", async (req) => {
    const body = UpdateUserBody.parse(req.body);
    const actorId = req.currentUser!.sub;
    const { id } = req.params;

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw NotFound("User not found");

      // ── RBAC guardrails ────────────────────────────────────────────
      // 1. Admin cannot change their own role (prevents accidental self-lockout)
      if (body.role !== undefined && id === actorId) {
        throw BadRequest("You cannot change your own role.");
      }
      // 2. Demoting an admin requires at least one other admin to remain
      if (body.role === "user" && existing.role === "admin") {
        const otherAdmins = await tx.user.count({
          where: { role: "admin", id: { not: id } },
        });
        if (otherAdmins === 0) {
          throw BadRequest("Cannot demote the last admin. Promote another user to admin first.");
        }
      }
      // 3. Suspending/expiring yourself is not allowed
      if (id === actorId && body.status && body.status !== "active") {
        throw BadRequest("You cannot suspend or expire your own account.");
      }
      // ──────────────────────────────────────────────────────────────

      const data: Prisma.UserUpdateInput = {
        email:       body.email === undefined ? undefined : body.email,
        phone:       body.phone === undefined ? undefined : body.phone,
        fullName:    body.fullName,
        role:        body.role,
        status:      body.status,
        certEnabled: body.certEnabled,
        validFrom:   body.validFrom  === undefined ? undefined : body.validFrom  ? new Date(body.validFrom)  : null,
        validUntil:  body.validUntil === undefined ? undefined : body.validUntil ? new Date(body.validUntil) : null,
      };

      // Username rename: purge old RADIUS rows before saving new username
      if (body.username) {
        const newUsername = body.username.toLowerCase();
        if (newUsername !== existing.username) {
          const conflict = await tx.user.findFirst({ where: { username: newUsername, NOT: { id } } });
          if (conflict) throw BadRequest("Username already taken");
          await purgeRadiusUsername(tx, existing.username);
          data.username = newUsername;
        }
      }

      await tx.user.update({ where: { id }, data });

      if (body.groupIds) {
        await tx.userGroup.deleteMany({ where: { userId: id } });
        if (body.groupIds.length) {
          await tx.userGroup.createMany({
            data: body.groupIds.map((gid, i) => ({ userId: id, groupId: gid, priority: i + 1 })),
          });
        }
      }

      await syncUserToRadius(tx, id);

      const after = await tx.user.findUnique({ where: { id }, include });
      await audit({
        tx,
        actorId,
        action: "user_update",
        targetType: "user",
        targetId: id,
        metadata: { changes: body },
        req,
      });
      return after!;
    });

    // Optional inline password reset (sent from the all-in-one edit form)
    if (body.newPassword) {
      await assertPasswordNotBreached(body.newPassword);
      await changeUserPassword({
        userId: id,
        newPassword: body.newPassword,
        actorId,
        mustChange: false,
        req,
      });
    }

    if (
      config().COA_DISCONNECT_ON_USER_POLICY_CHANGE &&
      (body.status !== undefined || body.validUntil !== undefined || body.groupIds !== undefined)
    ) {
      await disconnectForPolicyChange({
        userId: id,
        actorId,
        reason: "user_policy_change",
        req,
      });
    }

    return toSummary(updated);
  });

  // POST /admin/users/:id/reset-password
  app.post<{ Params: { id: string } }>("/users/:id/reset-password", async (req) => {
    const { newPassword, mustChange = true } = ResetPasswordBody.parse(req.body);
    const actorId = req.currentUser!.sub;
    const { id } = req.params;

    if (newPassword.length < 10) throw BadRequest("Password too short");

    await assertPasswordNotBreached(newPassword);
    await changeUserPassword({
      userId: id,
      newPassword,
      actorId,
      mustChange,
      req,
    });

    await audit({
      actorId,
      action: "user_reset_password",
      targetType: "user",
      targetId: id,
      metadata: { forced: true },
      req,
    });

    return { ok: true };
  });

  // DELETE /admin/users/:id  — hard delete with RADIUS cleanup.
  app.delete<{ Params: { id: string } }>("/users/:id", async (req) => {
    const actorId = req.currentUser!.sub;
    const { id } = req.params;

    if (id === actorId) throw BadRequest("Cannot delete your own account.");

    // Disconnect active sessions before removing the user
    await disconnectForPolicyChange({ userId: id, actorId, reason: "user_deleted", req });

    await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw NotFound("User not found");

      // RBAC: cannot remove the last admin
      if (existing.role === "admin") {
        const otherAdmins = await tx.user.count({
          where: { role: "admin", id: { not: id } },
        });
        if (otherAdmins === 0) {
          throw BadRequest("Cannot delete the last admin account. Promote another user first.");
        }
      }

      // Purge RADIUS rows before deleting the user
      await purgeRadiusUsername(tx, existing.username);

      // Hard delete — cascades to devices, certs, groups, secret
      await tx.user.delete({ where: { id } });

      await audit({
        tx,
        actorId,
        action:     "user_delete",
        targetType: "user",
        targetId:   id,
        metadata:   { username: existing.username },
        req,
      });
    });

    return { ok: true };
  });
};

export default adminUsers;
