// ─────────────────────────────────────────────────────────────────────
//  Automatic history cleanup.
//
//  Runs once at server startup then every 24 hours.
//  Deletes records older than CLEANUP_RETENTION_DAYS (default: 30).
//
//  Tables cleaned:
//    • radpostauth   — RADIUS auth log (accept + reject events)
//    • audit_logs    — Admin action log
// ─────────────────────────────────────────────────────────────────────

import pino from "pino";
import { prisma } from "../db.js";
import { config } from "../config.js";

const log = pino({ name: "cleanup" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function runCleanup(): Promise<void> {
  const days       = config().CLEANUP_RETENTION_DAYS;
  const cutoff     = new Date(Date.now() - days * MS_PER_DAY);
  const cutoffISO  = cutoff.toISOString();

  log.info({ cutoff: cutoffISO, retentionDays: days }, "cleanup.start");

  try {
    // 1. radpostauth — FreeRADIUS auth log (raw SQL, not in Prisma schema)
    const radResult = await prisma.$executeRawUnsafe(
      `DELETE FROM radpostauth WHERE authdate < $1::timestamptz`,
      cutoff,
    );

    // 2. audit_logs — admin action log
    const auditResult = await prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    log.info(
      { radpostauth: radResult, audit_logs: auditResult.count, cutoff: cutoffISO },
      "cleanup.done",
    );
  } catch (err) {
    log.error({ err }, "cleanup.error");
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the daily cleanup scheduler.
 * Call once from server startup — idempotent (ignores duplicate calls).
 */
export function startCleanupScheduler(): void {
  if (_timer) return;

  const days = config().CLEANUP_RETENTION_DAYS;
  log.info({ retentionDays: days, intervalHours: 24 }, "cleanup.scheduler_started");

  // Run immediately at startup, then every 24 h
  void runCleanup();
  _timer = setInterval(() => void runCleanup(), MS_PER_DAY);

  // Allow the process to exit cleanly even if the interval is active
  _timer.unref();
}
