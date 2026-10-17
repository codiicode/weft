// Records the demo app for the first-trade video (first.html): a fresh account with $250 types a
// thesis on /home, the draft arrives, Start trading, the run page, the portfolio.
// Run mock-api.mjs with FRESH=1 (no runs yet, $250 just deposited).
//   node content/shorts/record-first.mjs
import { recorder, wait } from "./rec-lib.mjs";

const THESIS = "Every time SOL drops 5% in a day, long SOL 10x with $100. Take profit at 30%, stop at 15%.";
const r = await recorder(new URL("./recordings/first/", import.meta.url).pathname, "FIRST");

// 1. Home: type the thesis
await r.goto("/home", 1800);
await r.shot("home");
await r.box("homeInput", "form input, form textarea");
await r.page.click("form input, form textarea");
await r.typeFrames("typing", THESIS, 2);

// 2. Send: the draft arrives
await r.page.keyboard.press("Enter");
await r.sequence("draft", { every: 150, ms: 16000, until: () => document.body.innerText.includes("Start trading"), tail: 1200 });
await wait(600);
await r.shot("draftDone");
await r.box("rules", "div", "Watches");
await r.box("start", "button", "Start trading");
await r.box("available", "p, div", "available");

// 3. Start it
await r.click("startClick", "button", "Start trading");
await r.sequence("start", { every: 150, ms: 5000 });
await r.shot("run");
await r.shot("runFull", true);
r.manifest.runUrl = r.page.url();

// 4. Portfolio
await r.goto("/portfolio", 2200);
await r.shot("portfolio");

r.save();
console.log("done");
await r.browser.close();
