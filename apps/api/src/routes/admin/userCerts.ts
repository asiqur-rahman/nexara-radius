// ─────────────────────────────────────────────────────────────────────
//  Admin: user-level EAP-TLS client certificate provisioning.
//
//  POST   /admin/users/:id/provision-cert
//  GET    /admin/users/:id/certs
//  GET    /admin/users/:id/certs/:certId/pkcs12
//  DELETE /admin/users/:id/certs/:certId
// ─────────────────────────────────────────────────────────────────────

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { Forbidden, NotFound } from "../../lib/errors.js";
import { issueUserCert } from "../../lib/userCertIssuance.js";
import { encrypt, decrypt } from "../../lib/encrypt.js";

function decryptPassword(stored: string | null): string | null {
  if (!stored) return null;
  try { return decrypt(stored); } catch { return null; }
}

function decryptBlob(stored: string | null): string | null {
  if (!stored) return null;
  try { return decrypt(stored); } catch { return null; }
}

const ProvisionBody = z.object({
  notes:          z.string().max(500).nullable().optional(),
  pkcs12Password: z.string().max(128).nullable().optional(),
});

const adminUserCerts: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.authorize(["admin"]));

  // GET /admin/users/:id/certs
  app.get<{ Params: { id: string } }>("/users/:id/certs", async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw NotFound("User not found");

    const certs = await prisma.userClientCert.findMany({
      where: { userId: req.params.id },
      orderBy: { createdAt: "desc" },
    });

    return certs.map((c) => ({
      id:             c.id,
      fingerprint:    c.fingerprint,
      commonName:     c.commonName,
      certPem:        c.certPem ?? null,
      pkcs12Password: decryptPassword(c.pkcs12Password),
      hasPkcs12:      Boolean(c.pkcs12Blob),
      expiresAt:      c.expiresAt.toISOString(),
      notes:          c.notes,
      createdAt:      c.createdAt.toISOString(),
    }));
  });

  // GET /admin/users/:id/certs/:certId/pkcs12
  app.get<{ Params: { id: string; certId: string } }>(
    "/users/:id/certs/:certId/pkcs12",
    async (req, reply) => {
      const cert = await prisma.userClientCert.findFirst({
        where: { id: req.params.certId, userId: req.params.id },
      });
      if (!cert) throw NotFound("Certificate not found");

      const pkcs12Base64 = decryptBlob(cert.pkcs12Blob);
      const pkcs12Password = decryptPassword(cert.pkcs12Password);
      if (!pkcs12Base64) {
        throw NotFound(
          "This certificate cannot be re-downloaded. Provision a new certificate to create a fresh .p12 file.",
        );
      }

      return reply.send({
        commonName:     cert.commonName,
        pkcs12Base64,
        pkcs12Password,
        expiresAt:      cert.expiresAt.toISOString(),
      });
    },
  );

  // POST /admin/users/:id/provision-cert
  app.post<{ Params: { id: string } }>("/users/:id/provision-cert", async (req, reply) => {
    const body    = ProvisionBody.parse(req.body);
    const actorId = req.currentUser!.sub;
    const { id }  = req.params;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw NotFound("User not found");
    if (!user.certEnabled) throw Forbidden("Certificate access is disabled for this user.");

    const bundle = await issueUserCert({
      username: user.username,
      email:    user.email,
      pkcs12Password: body.pkcs12Password,
    });

    await prisma.$transaction([
      prisma.userClientCert.deleteMany({ where: { userId: id } }),
      prisma.userClientCert.create({
        data: {
          userId:         id,
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
      actorId,
      action:     "cert_add",
      targetType: "user",
      targetId:   id,
      metadata:   { fingerprint: bundle.fingerprint, commonName: bundle.commonName },
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

  // DELETE /admin/users/:id/certs/:certId
  app.delete<{ Params: { id: string; certId: string } }>("/users/:id/certs/:certId", async (req) => {
    const actorId = req.currentUser!.sub;
    const cert = await prisma.userClientCert.findFirst({
      where: { id: req.params.certId, userId: req.params.id },
    });
    if (!cert) throw NotFound("Certificate not found");

    await prisma.userClientCert.delete({ where: { id: cert.id } });

    await audit({
      actorId,
      action:     "cert_delete",
      targetType: "user",
      targetId:   req.params.id,
      metadata:   { fingerprint: cert.fingerprint },
      req,
    });

    return { ok: true };
  });
};

export default adminUserCerts;
