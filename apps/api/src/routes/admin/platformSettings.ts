// ─────────────────────────────────────────────────────────────────────
//  Admin platform settings routes.
//
//  GET  /admin/settings/platform  — read all configurable settings
//  PUT  /admin/settings/platform  — update settings (partial)
//
//  Sensitive values (bot tokens, CA keys) are masked / omitted on GET.
// ─────────────────────────────────────────────────────────────────────

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  getTelegramSettings,
  saveTelegramSettings,
  reloadTelegramPolling,
  stopTelegramPolling,
} from "../../lib/telegram.js";
import {
  getCaInfo,
  saveCaToDB,
  loadCa,
  invalidateCaCache,
} from "../../lib/ca.js";
import {
  getCertSettings,
  saveCertSettings,
} from "../../lib/certSettings.js";
import {
  getReloadCommand,
  saveReloadCommand,
} from "../../lib/freeradius.js";
import { prisma } from "../../db.js";
import { BadRequest } from "../../lib/errors.js";

function maskSecret(value: string | null): string | null {
  if (!value || value.length < 8) return value ? "***" : null;
  return value.slice(0, 4) + "…" + value.slice(-4);
}

const PatchBody = z.object({
  telegram: z
    .object({
      botToken:    z.string().max(200).nullable().optional(),
      adminChatId: z.string().max(50).nullable().optional(),
    })
    .optional(),

  ca: z
    .object({
      certPem:       z.string().max(32_768).optional(),
      keyPem:        z.string().max(32_768).optional(),
      keyPassphrase: z.string().max(256).nullable().optional(),
      regenerate:    z.boolean().optional(),
    })
    .optional(),

  certSettings: z
    .object({
      validityDays:       z.coerce.number().int().min(1).max(397).optional(),
      organization:       z.string().max(128).optional(),
      organizationalUnit: z.string().max(128).optional(),
      country:            z.string().max(2).nullable().optional(),
      state:              z.string().max(128).nullable().optional(),
      locality:           z.string().max(128).nullable().optional(),
      userSelfService:    z.boolean().optional(),
    })
    .optional(),

  freeradius: z
    .object({
      reloadCommand: z.string().max(500).nullable().optional(),
    })
    .optional(),

  nac: z
    .object({
      maxDevicesPerUser: z.coerce.number().int().min(1).max(50).optional(),
    })
    .optional(),

  wifi: z
    .object({
      // IEEE 802.11 SSID is 0–32 octets; allow empty string to clear.
      defaultSsid: z.string().max(32).nullable().optional(),
    })
    .optional(),
});

const adminPlatformSettings: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.authorize(["admin"]));

  // Helper: read NAC settings from DB
  async function getNacSettings() {
    const row = await prisma.platformSetting.findUnique({ where: { key: "nac.max_devices_per_user" } });
    return {
      maxDevicesPerUser: row ? (parseInt(row.value, 10) || 3) : 3,
    };
  }

  async function getWifiSettings() {
    const row = await prisma.platformSetting.findUnique({ where: { key: "wifi.default_ssid" } });
    const value = row?.value?.trim() || "";
    return { defaultSsid: value || null };
  }

  async function buildPlatformResponse() {
    const [tg, caInfo, certSettings, reloadCmd, nac, wifi] = await Promise.all([
      getTelegramSettings(),
      getCaInfo(),
      getCertSettings(),
      getReloadCommand(),
      getNacSettings(),
      getWifiSettings(),
    ]);
    return {
      telegram: {
        botToken:    maskSecret(tg.botToken),
        adminChatId: tg.adminChatId,
        configured:  Boolean(tg.botToken && tg.adminChatId),
      },
      ca: caInfo,
      certSettings,
      freeradius: {
        reloadCommand: reloadCmd,
        configured:    Boolean(reloadCmd),
      },
      nac,
      wifi,
    };
  }

  // ── GET /admin/settings/platform ────────────────────────────────
  app.get("/settings/platform", async () => buildPlatformResponse());

  // ── PUT /admin/settings/platform ────────────────────────────────
  app.put<{ Body: z.infer<typeof PatchBody> }>("/settings/platform", async (req, reply) => {
    const body = PatchBody.parse(req.body);

    // ── Telegram ──────────────────────────────────────────────────
    if (body.telegram !== undefined) {
      const current = await getTelegramSettings();

      const rawToken = body.telegram.botToken;
      const newToken =
        rawToken === undefined
          ? undefined
          : rawToken === null
            ? null
            : rawToken.includes("…")
              ? undefined
              : rawToken.trim() || null;

      const newChatId =
        body.telegram.adminChatId === undefined
          ? undefined
          : body.telegram.adminChatId?.trim() || null;

      const changes: { botToken?: string | null; adminChatId?: string | null } = {};
      if (newToken !== undefined) changes.botToken = newToken;
      if (newChatId !== undefined) changes.adminChatId = newChatId;

      if (Object.keys(changes).length > 0) {
        await saveTelegramSettings(changes);

        const freshToken  = changes.botToken    !== undefined ? changes.botToken    : current.botToken;
        const freshChatId = changes.adminChatId !== undefined ? changes.adminChatId : current.adminChatId;
        if (freshToken && freshChatId) {
          await reloadTelegramPolling();
        } else {
          stopTelegramPolling();
        }
      }
    }

    // ── CA ────────────────────────────────────────────────────────
    if (body.ca !== undefined) {
      const { certPem, keyPem, keyPassphrase, regenerate } = body.ca;

      if (regenerate) {
        // Force re-generation: clear DB entry so loadCa() falls through to auto-gen.
        await prisma.platformSetting.deleteMany({
          where: { key: { in: ["ca.cert_pem", "ca.key_pem", "ca.key_passphrase"] } },
        });
        invalidateCaCache();
        await loadCa(); // triggers auto-gen + save
      } else if (certPem || keyPem) {
        // Upload custom CA — require both halves.
        if (!certPem?.trim())  throw BadRequest("ca.certPem is required when uploading a CA");
        if (!keyPem?.trim())   throw BadRequest("ca.keyPem is required when uploading a CA");
        await saveCaToDB(certPem, keyPem, keyPassphrase ?? null);
      }
    }

    // ── Cert Settings ─────────────────────────────────────────────
    if (body.certSettings !== undefined) {
      await saveCertSettings(body.certSettings);
    }

    // ── FreeRADIUS reload command ─────────────────────────────────
    if (body.freeradius !== undefined && body.freeradius.reloadCommand !== undefined) {
      await saveReloadCommand(body.freeradius.reloadCommand ?? null);
    }

    // ── NAC settings ──────────────────────────────────────────────
    if (body.nac?.maxDevicesPerUser !== undefined) {
      await prisma.platformSetting.upsert({
        where:  { key: "nac.max_devices_per_user" },
        create: { key: "nac.max_devices_per_user", value: String(body.nac.maxDevicesPerUser) },
        update: { value: String(body.nac.maxDevicesPerUser) },
      });
    }

    // ── Wi‑Fi portal defaults ─────────────────────────────────────
    if (body.wifi?.defaultSsid !== undefined) {
      const ssid = body.wifi.defaultSsid?.trim() || "";
      if (!ssid) {
        await prisma.platformSetting.deleteMany({ where: { key: "wifi.default_ssid" } });
      } else {
        await prisma.platformSetting.upsert({
          where:  { key: "wifi.default_ssid" },
          create: { key: "wifi.default_ssid", value: ssid },
          update: { value: ssid },
        });
      }
    }

    return reply.status(200).send(await buildPlatformResponse());
  });
};

export default adminPlatformSettings;
