// Renders apps/web/public/og.png (the link preview) from og.html with the site's own fonts.
// Usage: node scripts/og/render.mjs   (needs Google Chrome installed)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const sharp = require("sharp");
const html = new URL("og.html", import.meta.url).pathname;
const shot = join(tmpdir(), `weft-og-${process.pid}.png`);
execFileSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
  "--window-size=1200,630", "--virtual-time-budget=3000", `--screenshot=${shot}`, `file://${html}`,
], { stdio: "ignore" });
await sharp(shot).resize(1200, 630).png({ compressionLevel: 9 }).toFile(new URL("../../apps/web/public/og.png", import.meta.url).pathname);
console.log("og.png written");
