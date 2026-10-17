// Records the copy-trading short: the traders list, Copy, a condition added in words, the draft,
// then the running copy with the trades it mirrored. Frames → recordings/copy/ for copy.html.
//   node content/shorts/record-copy.mjs
import { recorder, wait } from "./rec-lib.mjs";

const OUT = new URL("./recordings/copy/", import.meta.url).pathname;
const r = await recorder(OUT, "COPY");
const { page } = r;

// The list, then Copy on the top trader
await r.goto("/traders", 2500);
await r.shot("traders");
await r.box("row1", "tbody tr, [role=row]", "0xeadc");
await r.click("copy", "a, button", "Copy");
await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
await wait(1500);
await r.shot("prefilled");

// Add a condition in plain words
await r.box("input", "textarea, input[type=text]");
await page.focus("textarea, input[type=text]");
await page.evaluate(() => { const el = document.querySelector("textarea, input[type=text]"); el.setSelectionRange(el.value.length, el.value.length); });
await r.typeFrames("typing", " Only while BTC is above $80,000.", 1);

// Draft it
await r.box("draftBtn", "button", "Draft");
await page.keyboard.down("Meta"); await page.keyboard.press("Enter"); await page.keyboard.up("Meta");
await r.sequence("draft", { every: 150, ms: 16000, until: () => document.body.innerText.includes("Start trading"), tail: 1000 });
await wait(500);
await r.shot("drafted");
await r.shot("draftedFull", true);
await r.box("start", "button", "Start trading");

// Hours later: the running copy
await r.goto("/run?id=demo-copy", 6000);
await r.shot("run");
await r.shot("runFull", true);

// And in the portfolio
await r.goto("/portfolio", 2500);
await r.shot("portfolio");

r.save();
await r.browser.close();
console.log("done");
