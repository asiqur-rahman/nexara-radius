#!/usr/bin/env node
import "../dist/loadAppEnv.js";
import { ensureOpenNasIfMissingWithCleanup } from "../dist/seed/runSeed.js";

ensureOpenNasIfMissingWithCleanup().catch((err) => {
  console.error(err);
  process.exit(1);
});
