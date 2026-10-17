// Renders video.html frame by frame in headless Chrome and encodes it with ffmpeg.
//   node content/launch-video/render.mjs                 → out/weft-launch.mp4 (60 fps)
//   node content/launch-video/render.mjs --fps 30        → faster draft
//   node content/launch-video/render.mjs --stills 2,9.5  → out/still-2.png, out/still-9.5.png
//   node content/launch-video/render.mjs --from 20 --to 30 --fps 30 → a short clip of one part
//   --page content/shorts/tour.html --out content/shorts/out/ --name tour → any other film page
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const ffmpeg = require("@ffmpeg-installer/ffmpeg").path;
const here = new URL(".", import.meta.url).pathname;
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const pageFile = new URL(arg("page", `${here}video.html`), `file://${process.cwd()}/`).pathname;
const out = new URL(arg("out", `${here}out/`), `file://${process.cwd()}/`).pathname.replace(/\/?$/, "/");
mkdirSync(out, { recursive: true });
const fps = Number(arg("fps", 60));
const stills = arg("stills", null);
const name = arg("name", "weft-launch");

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--hide-scrollbars", "--allow-file-access-from-files", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(`file://${pageFile}`, { waitUntil: "load" });
await page.evaluate(() => window.ready ?? null);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

const shoot = async (t, type = "jpeg") => {
  await page.evaluate((x) => window.renderAt(x), t);
  return page.screenshot({ type, ...(type === "jpeg" ? { quality: 95 } : {}), clip: { x: 0, y: 0, width: 1920, height: 1080 }, optimizeForSpeed: true });
};

if (stills) {
  for (const t of stills.split(",").map(Number)) {
    writeFileSync(`${out}still-${t}.png`, await shoot(t, "png"));
    console.log(`still ${t}s`);
  }
} else {
  const from = Number(arg("from", 0));
  const to = Number(arg("to", duration));
  const frames = Math.round((to - from) * fps);
  const file = `${out}${name}.mp4`;
  const ff = spawn(ffmpeg, [
    "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart",
    file,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    const buf = await shoot(from + f / fps);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % (fps * 5) === 0) console.log(`${(f / fps).toFixed(0)}s / ${(frames / fps).toFixed(0)}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`wrote ${file}`);
}
await browser.close();
