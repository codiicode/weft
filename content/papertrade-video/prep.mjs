// Data for the Papertrade video: real BTC 1-minute candles from Hyperliquid (the price Papertrade
// settles at). We look back over the last few days for a moment that played out like the film's
// strategy: BTC breaks a round $100 level, a 1000× long goes in, and the +100% target (a 0.1% move)
// is reached before the −30% stop (0.03% down), with no candle touching the stop on the way.
//   node content/papertrade-video/prep.mjs  -> data.js
import { writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const LEV = 1000, TP = 1.0, SL = 0.3, MARGIN = 20;
const BTC = { rateMultiplier: 15_000, positionMultiplier: 814.598, bustBuffer: 0.000476041580087574, baseRate: 0.1, referenceNotional: 100_000 };
// same math as packages/venues/src/papertrade.ts (synthBustPrice, synthSettlement)
const bust = (e) => Math.floor(Math.ceil((Math.round(e * 10) * (LEV - 1)) / LEV) * (1 + BTC.bustBuffer)) / 10;
function settle(entry, exit, notional) {
  const e = Math.round(entry * 10), x = Math.round(exit * 10);
  const gainRaw = x - e - Math.floor(e / 50_000);
  const move = gainRaw / e;
  const scale = (1 - BTC.baseRate) / (1 + 1 / (move * BTC.rateMultiplier) + BTC.referenceNotional / (1e6 * move * BTC.positionMultiplier));
  return { pnl: notional * move * scale * 0.98, rawPnl: (notional * (exit - entry)) / entry };
}
const end = Date.now(), start = end - 4 * 864e5;
const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: start, endTime: end } }) }).then((x) => x.json());
const c = r.map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c }));
const found = [];
for (let i = 1; i < c.length - 1; i++) {
  const L = Math.ceil(c[i - 1].c / 100) * 100;
  if (!(c[i - 1].c < L && c[i].h >= L && c[i].o < L)) continue;
  const e = L, tp = e * (1 + TP / LEV), sl = e * (1 - SL / LEV);
  if (c[i].c < e) continue; // closed back under: skip, keep it clean
  let j = i + 1, ok = false;
  for (; j < c.length && j < i + 30; j++) { if (c[j].l <= sl) break; if (c[j].h >= tp) { ok = true; break; } }
  if (!ok || j - i < 3) continue;
  let low = e; for (let k = i + 1; k <= j; k++) low = Math.min(low, c[k].l);
  found.push({ i, j, level: L, dip: (e - low) / (e - sl), mins: j - i });
}
found.sort((a, b) => b.dip - a.dip);
const pick = found.find((f) => f.dip < 0.9 && f.mins <= 15) ?? found[0];
if (!pick) { console.log("nothing found"); process.exit(1); }
const from = pick.i - 12, to = pick.j + 4;
const entry = pick.level, tp = entry * (1 + TP / LEV);
const st = settle(entry, tp, MARGIN * LEV);
console.log(found.length, "moments; picked", new Date(c[pick.i].t).toISOString(), pick, "bust", bust(entry), "payout", st.pnl.toFixed(2), "raw", st.rawPnl.toFixed(2));
const day = c.filter((k) => k.t >= c[to].t - 864e5 && k.t <= c[to].t).filter((_, k) => k % 5 === 0).map((k) => k.c);
writeFileSync(`${here}data.js`, `window.PT_DATA = ${JSON.stringify({
  candles: c.slice(from, to + 1), entryIdx: pick.i - from, exitIdx: pick.j - from,
  level: pick.level, entry, tp, sl: entry * (1 - SL / LEV), bust: bust(entry),
  payout: st.pnl, raw: st.rawPnl, margin: MARGIN, lev: LEV, deposit: Math.ceil((MARGIN / 0.99) * 100) / 100, day,
})};\n`);
