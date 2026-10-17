// Drives the demo build of the app (serve-demo.mjs + mock-api.mjs) through the tour and saves
// frames at 2× for tour.html to animate: typing, the draft arriving, the backtest, starting it,
// the portfolio, markets and traders. Element boxes for the cursor go to manifest.json.
//   node content/shorts/record-tour.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const APP = "http://localhost:3100";
const OUT = new URL("./recordings/tour/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const THESIS = "Every time SOL drops 5% in a day, long SOL 10x with $100. Take profit at 30%, stop at 15%.";

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
page.on("pageerror", (e) => console.log("page error:", e.message.slice(0, 160)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = { viewport: [1600, 1000], shots: {}, boxes: {}, seqs: {} };

const shot = async (name, full = false) => {
  const file = `${name}.jpg`;
  await page.screenshot({ path: OUT + file, type: "jpeg", quality: 92, fullPage: full });
  const h = full ? await page.evaluate(() => document.documentElement.scrollHeight) : 1000;
  manifest.shots[name] = { file, h };
  console.log("shot", name, full ? `(full, ${h}px)` : "");
};
/** Box of the first element matching `sel` whose text includes `text`, in page coordinates. */
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
const click = async (name, sel, text) => { const [x, y, w, h] = await box(name, sel, text); await page.mouse.click(x + w / 2 - (await page.evaluate(() => scrollX)), y + h / 2 - (await page.evaluate(() => scrollY))); };
/** Screenshots every `every` ms for `ms`, or until `until()` is true plus `tail` ms. */
async function sequence(name, { every = 200, ms = 10000, until = null, tail = 800 } = {}) {
  const frames = []; const t0 = Date.now(); let done = null;
  while (Date.now() - t0 < ms) {
    const f = `${name}-${String(frames.length).padStart(3, "0")}.jpg`;
    await page.screenshot({ path: OUT + f, type: "jpeg", quality: 88 });
    frames.push([Date.now() - t0, f]);
    if (until && !done && (await page.evaluate(until))) done = Date.now();
    if (done && Date.now() - done > tail) break;
    await wait(every);
  }
  manifest.seqs[name] = frames;
  console.log("seq", name, frames.length, "frames");
}

// 1. Home: type the thesis
await page.goto(`${APP}/home`, { waitUntil: "networkidle2" }); await wait(1500);
await shot("home");
await box("homeInput", "form input, form textarea");
await page.click("form input, form textarea");
const typing = [];
for (let i = 0; i < THESIS.length; i++) {
  await page.keyboard.type(THESIS[i]);
  if (i % 2 === 1 || i === THESIS.length - 1) { const f = `type-${String(typing.length).padStart(3, "0")}.jpg`; await page.screenshot({ path: OUT + f, type: "jpeg", quality: 88 }); typing.push([i + 1, f]); }
}
manifest.seqs.typing = typing;
console.log("typed", typing.length, "frames");

// 2. Send: the draft arrives
await page.keyboard.press("Enter");
await sequence("draft", { every: 150, ms: 14000, until: () => document.body.innerText.includes("Start trading"), tail: 1200 });
await wait(600);
await shot("draftDone");
await shot("draftFull", true);
await box("rules", "h2, h3, div", "Watches");

// 3. Backtest it over 90 days
await click("days90", "button", "90 days");
await wait(300);
await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === "Test it"); b.scrollIntoView({ block: "center" }); });
await wait(500);
await box("testIt", "button", "Test it");
manifest.scrollBeforeTest = await page.evaluate(() => scrollY);
await shot("beforeTest");
await click("testItClick", "button", "Test it");
await sequence("backtest", { every: 150, ms: 20000, until: () => /Return|return/.test(document.body.innerText) && !/Testing|Running/.test(document.body.innerText), tail: 1500 });
manifest.scrollAfterTest = await page.evaluate(() => scrollY);
await shot("backtestDone");
await shot("backtestFull", true);

// 4. Start it
await page.evaluate(() => window.scrollTo(0, 0)); await wait(400);
await box("start", "button", "Start trading");
await shot("beforeStart");
await click("startClick", "button", "Start trading");
await sequence("start", { every: 150, ms: 5000 });
await shot("afterStart");
manifest.afterStartUrl = page.url();

// 5. Portfolio
await page.goto(`${APP}/portfolio`, { waitUntil: "networkidle2" }); await wait(2000);
await shot("portfolio"); await shot("portfolioFull", true);

// 6. Markets: the four tabs
await page.goto(`${APP}/markets`, { waitUntil: "networkidle2" }); await wait(2500);
await shot("markets");
for (const [name, tab] of [["stocks", "Stocks"], ["predictions", "Predictions"], ["solana", "Solana tokens"]]) {
  await click(`tab-${name}`, "button, a", tab); await wait(2500); await shot(`markets-${name}`);
}

// 7. Traders
await page.goto(`${APP}/traders`, { waitUntil: "networkidle2" }); await wait(2500);
await shot("traders");
await box("copyBtn", "a, button", "Copy");

writeFileSync(OUT + "manifest.json", JSON.stringify(manifest, null, 1));
writeFileSync(OUT + "manifest.js", `window.TOUR = ${JSON.stringify(manifest)};\n`);
console.log("done →", OUT);
await browser.close();
