// Shared helpers for recording the demo app (serve-demo.mjs + mock-api.mjs) at 2×: full and
// viewport screenshots, element boxes for the cursor, and timed frame sequences.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

export const APP = "http://localhost:3100";
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function recorder(outDir, globalName) {
  rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  page.on("pageerror", (e) => console.log("page error:", e.message.slice(0, 160)));
  const manifest = { viewport: [1600, 1000], shots: {}, boxes: {}, seqs: {} };
  const scroll = () => page.evaluate(() => [scrollX, scrollY]);

  const shot = async (name, full = false) => {
    const file = `${name}.jpg`;
    await page.screenshot({ path: outDir + file, type: "jpeg", quality: 92, fullPage: full });
    manifest.shots[name] = { file, h: full ? await page.evaluate(() => document.documentElement.scrollHeight) : 1000, scrollY: (await scroll())[1] };
    console.log("shot", name);
  };
  /** Box of the first element matching `sel` (with `text` in it), in page coordinates. */
  const box = async (name, sel, text = null) => {
    const b = await page.evaluate((sel, text) => {
      const el = [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.trim().includes(text));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left + scrollX, r.top + scrollY, r.width, r.height];
    }, sel, text);
    if (!b) throw new Error(`no ${sel} ${text ?? ""}`);
    manifest.boxes[name] = b;
    return b;
  };
  const click = async (name, sel, text) => { const [x, y, w, h] = await box(name, sel, text); const [sx, sy] = await scroll(); await page.mouse.click(x + w / 2 - sx, y + h / 2 - sy); };
  /** Screenshots every `every` ms for `ms`, or until `until()` holds plus `tail` ms. */
  const sequence = async (name, { every = 150, ms = 10000, until = null, tail = 800 } = {}) => {
    const frames = []; const t0 = Date.now(); let done = null;
    while (Date.now() - t0 < ms) {
      const f = `${name}-${String(frames.length).padStart(3, "0")}.jpg`;
      await page.screenshot({ path: outDir + f, type: "jpeg", quality: 88 });
      frames.push([Date.now() - t0, f]);
      if (until && !done && (await page.evaluate(until))) done = Date.now();
      if (done && Date.now() - done > tail) break;
      await wait(every);
    }
    manifest.seqs[name] = frames;
    console.log("seq", name, frames.length);
  };
  /** Types `text`, saving a frame every `every` characters. */
  const typeFrames = async (name, text, every = 2) => {
    const frames = [];
    for (let i = 0; i < text.length; i++) {
      await page.keyboard.type(text[i]);
      if (i % every === every - 1 || i === text.length - 1) { const f = `${name}-${String(frames.length).padStart(3, "0")}.jpg`; await page.screenshot({ path: outDir + f, type: "jpeg", quality: 88 }); frames.push([i + 1, f]); }
    }
    manifest.seqs[name] = frames;
    console.log("typed", name, frames.length);
  };
  const save = () => {
    writeFileSync(outDir + "manifest.json", JSON.stringify(manifest, null, 1));
    writeFileSync(outDir + "manifest.js", `window.${globalName} = ${JSON.stringify(manifest)};\n`);
  };
  return { browser, page, manifest, shot, box, click, sequence, typeFrames, save, goto: async (path, ms = 2000) => { await page.goto(APP + path, { waitUntil: "networkidle2" }); await wait(ms); } };
}
