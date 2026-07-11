/**
 * Rasterize apps/web/public/icons/icon.svg → icon-192.png / icon-512.png
 *
 * Usage (from repo root):
 *   node ops/generate-pwa-icons.mjs
 *
 * First run installs @resvg/resvg-js into ops/icon-tools (gitignored).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const iconsDir = join(root, "apps/web/public/icons");
const toolsDir = join(__dirname, "icon-tools");
const svgPath = join(iconsDir, "icon.svg");

if (!existsSync(join(toolsDir, "node_modules/@resvg/resvg-js"))) {
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, "package.json"), JSON.stringify({ name: "icon-tools", private: true }, null, 2));
  const install = spawnSync("npm", ["install", "@resvg/resvg-js", "--no-fund", "--no-audit"], {
    cwd: toolsDir,
    stdio: "inherit",
    shell: true,
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const require = createRequire(join(toolsDir, "package.json"));
const { Resvg } = require("@resvg/resvg-js");
const svg = readFileSync(svgPath);

for (const size of [192, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const out = join(iconsDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
