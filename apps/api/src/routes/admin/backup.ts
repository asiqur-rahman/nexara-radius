// ─────────────────────────────────────────────────────────────────────
//  Admin full-system backup / restore.
// ─────────────────────────────────────────────────────────────────────
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { BadRequest } from "../../lib/errors.js";
import {
  buildSystemBackup,
  parseBackupArchive,
  restoreSystemBackup,
} from "../../services/systemBackup.js";

const RestoreBody = z.object({
  confirm: z.literal("RESTORE"),
  /** Base64 of .json.gz (or raw gzip bytes) OR raw JSON string. */
  archiveBase64: z.string().min(1).max(80_000_000),
});

const adminBackup: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.authorize(["admin"]));

  // GET /admin/backup?includeHistory=true|false
  app.get("/backup", async (req, reply) => {
    const q = z
      .object({
        includeHistory: z
          .union([z.literal("true"), z.literal("false"), z.boolean()])
          .optional()
          .transform((v) => v === undefined || v === true || v === "true"),
      })
      .parse(req.query);

    const { gzip, filename, document } = await buildSystemBackup({
      includeHistory: q.includeHistory,
    });

    await audit({
      actorId: req.currentUser!.sub,
      action: "user_update",
      targetType: "system",
      targetId: "backup",
      metadata: {
        event: "system.backup",
        filename,
        includeHistory: document.includeHistory,
        counts: document.counts,
      },
      req,
    });

    return reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("X-Nexara-Backup-Users", String(document.counts.users ?? 0))
      .header("X-Nexara-Backup-Devices", String(document.counts.userDevices ?? 0))
      .send(gzip);
  });

  // POST /admin/backup/restore  — destructive
  app.post(
    "/backup/restore",
    { bodyLimit: 64 * 1024 * 1024 },
    async (req) => {
      const body = RestoreBody.parse(req.body);
      let doc;
      try {
        doc = parseBackupArchive(body.archiveBase64);
      } catch (err) {
        if (err instanceof Error && "statusCode" in err) throw err;
        throw BadRequest(err instanceof Error ? err.message : "Invalid backup archive");
      }

      const result = await restoreSystemBackup(doc);

      await audit({
        actorId: req.currentUser!.sub,
        action: "user_update",
        targetType: "system",
        targetId: "restore",
        metadata: {
          event: "system.restore",
          restored: result.restored,
          reloaded: result.reloaded,
          reloadError: result.reloadError ?? null,
          backupExportedAt: doc.exportedAt,
        },
        req,
      });

      return result;
    },
  );
};

export default adminBackup;
