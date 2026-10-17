import puppeteer from "puppeteer-core";
const here = new URL(".", import.meta.url).pathname;
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--allow-file-access-from-files"] });
for (const [v, dpr] of [["logo-dark", 2], ["logo-light", 2], ["mark", 1], ["pfp", 1]]) {
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 1100, deviceScaleFactor: dpr });
  await p.goto(`file://${here}kit.html?v=${v}`, { waitUntil: "load" }); await p.evaluate(() => window.ready);
  const el = await p.$("#v > *"); await el.screenshot({ path: `${here}weft-${v}.png`, omitBackground: true }); await p.close();
}
await b.close();
