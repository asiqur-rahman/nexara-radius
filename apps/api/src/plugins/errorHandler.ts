// Maps AppError + ZodError + Prisma errors into a consistent JSON shape.
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { AppError } from "../lib/errors.js";

const plugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: err.code,
        message: err.message,
        details: err.details,
      });
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "validation_failed",
        message: "Request validation failed",
        details: err.flatten(),
      });
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Unique constraint, FK failure, etc.
      if (err.code === "P2002") {
        const target = (err.meta?.target as string[] | undefined)?.join(",") ?? "field";
        return reply.status(409).send({
          error: "conflict",
          message: `Unique constraint violation on ${target}`,
        });
      }
      if (err.code === "P2025") {
        return reply.status(404).send({ error: "not_found", message: "Record not found" });
      }
      const pg = typeof err.meta?.message === "string" ? err.meta.message : err.message;
      return reply.status(400).send({
        error: "bad_request",
        message: pg.replace(/^ERROR:\s*/i, "").split("\n")[0] ?? pg,
      });
    }

    // Fastify validation / parse errors (e.g. invalid JSON body)
    const status = typeof err === "object" && err && "statusCode" in err
      ? Number((err as { statusCode?: number }).statusCode)
      : undefined;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: "bad_request",
        message: err instanceof Error ? err.message : "Bad request",
      });
    }

    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({
      error: "internal_error",
      message: "An internal error occurred",
    });
  });
};

export default fp(plugin, { name: "error-handler" });
