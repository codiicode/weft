import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--allow-file-access-from-files"] });
const p = await b.newPage(); await p.setViewport({ width: 1920, height: 1080 });
p.on("console", (m) => console.log("console:", m.text())); p.on("pageerror", (e) => console.log("ERR", e.message));
await p.goto(`file://${process.cwd()}/video.html`); await p.evaluate(() => document.fonts.ready);
console.log(await p.evaluate(process.argv[2]));
await b.close();
