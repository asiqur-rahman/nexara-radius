// ─────────────────────────────────────────────────────────────────────
//  Self-service: user manages their own EAP-TLS client certificates.
//
//  GET  /me/certs                    — list own certs (+ password, hasPkcs12)
//  GET  /me/certs/:certId/pkcs12     — re-download encrypted .p12
//  POST /me/certs/provision          — generate a new cert; returns bundle
//  DELETE /me/certs/:certId          — revoke own cert
// ─────────────────────────────────────────────────────────────────────

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { audit } from "../lib/audit.js";
import { Forbidden, NotFound } from "../lib/errors.js";
import { issueUserCert } from "../lib/userCertIssuance.js";
import { getCertSettings } from "../lib/certSettings.js";
import { encrypt, decrypt } from "../lib/encrypt.js";

const ProvisionBody = z.object({
  pkcs12Password: z.string().max(128).nullable().optional(),
  notes:          z.string().max(500).nullable().optional(),
});

function decryptPassword(stored: string | null): string | null {
  if (!stored) return null;
  try { return decrypt(stored); } catch { return null; }
}

function decryptBlob(stored: string | null): string | null {
  if (!stored) return null;
  try { return decrypt(stored); } catch { return null; }
}

const meCerts: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // GET /me/certs
  app.get("/me/certs", async (req) => {
    const userId = req.currentUser!.sub;
    const [rows, certSettings] = await Promise.all([
      prisma.userClientCert.findMany({
        where:   { userId },
        orderBy: { createdAt: "desc" },
      }),
      getCertSettings(),
    ]);

    return {
      userSelfService: certSettings.userSelfService,
      certs: rows.map((c) => ({
        id:             c.id,
        fingerprint:    c.fingerprint,
        commonName:     c.commonName,
        certPem:        c.certPem ?? null,
        pkcs12Password: decryptPassword(c.pkcs12Password),
        hasPkcs12:      Boolean(c.pkcs12Blob),
        expiresAt:      c.expiresAt.toISOString(),
        notes:          c.notes,
        createdAt:      c.createdAt.toISOString(),
      })),
    };
  });

  // GET /me/certs/:certId/pkcs12 — re-download importable .p12
  app.get<{ Params: { certId: string } }>("/me/certs/:certId/pkcs12", async (req, reply) => {
    const userId = req.currentUser!.sub;
    const cert = await prisma.userClientCert.findFirst({
      where: { id: req.params.certId, userId },
    });
    if (!cert) throw NotFound("Certificate not found");

    const pkcs12Base64 = decryptBlob(cert.pkcs12Blob);
    const pkcs12Password = decryptPassword(cert.pkcs12Password);
    if (!pkcs12Base64) {
      throw NotFound(
        "This certificate cannot be re-downloaded. Generate a new WiFi certificate to get a fresh .p12 file.",
      );
    }

    return reply.send({
      commonName:     cert.commonName,
      pkcs12Base64,
      pkcs12Password,
      expiresAt:      cert.expiresAt.toISOString(),
    });
  });

  // POST /me/certs/provision
  app.post("/me/certs/provision", async (req, reply) => {
    const certSettings = await getCertSettings();
    if (!certSettings.userSelfService) {
      throw Forbidden("Self-service certificate generation is disabled. Contact your administrator.");
    }

    const body   = ProvisionBody.parse(req.body);
    const userId = req.currentUser!.sub;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, certEnabled: true },
    });
    if (!user) throw NotFound("User not found");
    if (!user.certEnabled) throw Forbidden("Certificate access is disabled for your account. Contact your administrator.");

    const bundle = await issueUserCert({
      username: user.username,
      email:    user.email,
      pkcs12Password: body.pkcs12Password,
    });

    // One cert per user — delete any existing cert before creating the new one
    await prisma.$transaction([
      prisma.userClientCert.deleteMany({ where: { userId } }),
      prisma.userClientCert.create({
        data: {
          userId:         userId,
          fingerprint:    bundle.fingerprint,
          commonName:     bundle.commonName,
          certPem:        bundle.certificatePem,
          pkcs12Password: encrypt(bundle.pkcs12Password),
          pkcs12Blob:     encrypt(bundle.pkcs12Base64),
          expiresAt:      bundle.expiresAt,
          notes:          body.notes ?? null,
        },
      }),
    ]);

    await audit({
      actorId:    userId,
      action:     "cert_add",
      targetType: "user",
      targetId:   userId,
      metadata:   { fingerprint: bundle.fingerprint, commonName: bundle.commonName, source: "self-service" },
      req,
    });

    return reply.status(201).send({
      fingerprint:    bundle.fingerprint,
      commonName:     bundle.commonName,
      expiresAt:      bundle.expiresAt.toISOString(),
      certificatePem: bundle.certificatePem,
      privateKeyPem:  bundle.privateKeyPem,
      pkcs12Base64:   bundle.pkcs12Base64,
      pkcs12Password: bundle.pkcs12Password,
    });
  });

  // DELETE /me/certs/:certId — revoke
  app.delete<{ Params: { certId: string } }>("/me/certs/:certId", async (req) => {
    const userId = req.currentUser!.sub;
    const cert = await prisma.userClientCert.findFirst({
      where: { id: req.params.certId, userId },
    });
    if (!cert) throw NotFound("Certificate not found");

    await prisma.userClientCert.delete({ where: { id: cert.id } });

    await audit({
      actorId:    userId,
      action:     "cert_delete",
      targetType: "user",
      targetId:   userId,
      metadata:   { fingerprint: cert.fingerprint, source: "self-service" },
      req,
    });

    return { ok: true };
  });
};

export default meCerts;
