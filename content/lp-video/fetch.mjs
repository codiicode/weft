// Real data for the LP video: Meteora DLMM pool stats and SOL 5m candles from Hyperliquid.
//   node content/lp-video/fetch.mjs  -> data.js
import { writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const j = (u, o) => fetch(u, o).then((r) => r.json());
const pick = (p) => ({ address: p.address, name: p.name, x: p.token_x.symbol, y: p.token_y.symbol, xMint: p.token_x.address, yMint: p.token_y.address, binStep: p.pool_config.bin_step, baseFeePct: p.pool_config.base_fee_pct, tvl: p.tvl, price: p.current_price, vol24h: p.volume["24h"], fees24h: p.fees["24h"] });
const busiest = async (q) => {
  const r = await j(`https://dlmm.datapi.meteora.ag/pools?query=${q}&page_size=20`);
  const [x, y] = q.split("-");
  return r.data.filter((p) => p.token_x.symbol === x && p.token_y.symbol === y && p.token_x.is_verified && p.token_y.is_verified).sort((a, b) => b.tvl - a.tvl)[0];
};
const pools = [];
for (const q of process.argv.slice(2).length ? process.argv.slice(2) : ["SOL-USDC", "JUP-SOL", "JUP-USDC", "cbBTC-SOL", "WETH-SOL", "SOL-USDT", "JitoSOL-SOL", "cbBTC-USDC"]) {
  const p = await busiest(q).catch(() => null);
  console.log(q, p ? `${p.address} tvl ${Math.round(p.tvl)} vol ${Math.round(p.volume["24h"])} fees ${Math.round(p.fees["24h"])} bin ${p.pool_config.bin_step}` : "none");
  if (p) pools.push(pick(p));
}
const end = Date.now(), start = end - 3 * 864e5;
const candles = await j("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: "SOL", interval: "5m", startTime: start, endTime: end } }) });
const sol = candles.map((c) => [c.t, +c.o, +c.h, +c.l, +c.c]);
console.log("SOL candles", sol.length, sol[0]?.[4], sol.at(-1)?.[4]);
writeFileSync(`${here}data.js`, `window.LP_DATA = ${JSON.stringify({ fetchedAt: end, pools, sol })};\n`);
