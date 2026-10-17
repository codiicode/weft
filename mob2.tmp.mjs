import puppeteer from "puppeteer-core";
const OUT = "/private/tmp/claude-501/mob/";
const url = process.argv[2], tag = process.argv[3];
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--force-color-profile=srgb"] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await p.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await p.goto(url, { waitUntil: "load", timeout: 45000 }); await new Promise(r => setTimeout(r, 2500));
const H = await p.evaluate(() => document.documentElement.scrollHeight);
let i = 0;
for (let y = 0; y < H; y += 780) {
  await p.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), y);
  await new Promise(r => setTimeout(r, 1300));
  await p.screenshot({ path: `${OUT}${tag}-${String(i++).padStart(2, "0")}.png` });
}
console.log(tag, i, "screens");
await b.close();
