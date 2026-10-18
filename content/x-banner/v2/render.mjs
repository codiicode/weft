// Renders banners.html?v=1|2|3 to out/weft-x-banner-<v>.png (1500×500) and @2x (3000×1000).
//   node content/x-banner/v2/render.mjs [1,2,3]
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const here = new URL(".", import.meta.url).pathname;
mkdirSync(`${here}out`, { recursive: true });
const which = (process.argv[2] ?? "1a,1b,1c").split(",");
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--hide-scrollbars", "--allow-file-access-from-files", "--force-color-profile=srgb", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
for (const v of which) {
  for (const [scale, suffix] of [[2, "@2x"], [1, ""]]) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`v${v}: ${e.message}`));
    const [W, H] = ["safe", "split"].includes(v) ? [1080, 1080] : ["spurs", "w1", "w2", "w3", "fees", "start", "earnings", "news", "copy", "thesis", "edit", "macro", "publish", "copy2", "plan", "custody", "say", "mcp", "claim", "rift", "papertrade"].includes(v) ? [1600, 900] : v.startsWith("pfp") ? [1000, 1000] : [1500, 500];
    await page.setViewport({ width: W, height: H, deviceScaleFactor: scale });
    await page.goto(`file://${here}banners.html?v=${v}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => window.ready);
    await page.screenshot({ path: `${here}out/weft-x-banner-${v}${suffix}.png`, clip: { x: 0, y: 0, width: W, height: H } });
    await page.close();
  }
  console.log(`banner ${v}`);
}
await browser.close();
