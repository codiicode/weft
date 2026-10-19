import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { instrumentLabel, type Strategy } from "@weft/strategy";

/**
 * Link previews for shared strategies. weft.fi is a static site, so a crawler (X, Telegram,
 * Discord…) can't see a strategy's own title and picture there. A share link (weft.fi/s/<id>) is
 * served by the API instead: a tiny page with the strategy's Open Graph tags that sends people on
 * to the strategy, and a 1200×630 card drawn here with Weft's own fonts.
 */

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => readFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), "files", file));
let fonts: { name: string; data: Buffer; weight: 400 | 600 | 700; style: "normal" }[] | null = null;
const loadFonts = () =>
  (fonts ??= [
    { name: "Instrument Sans", data: font("@fontsource/instrument-sans", "instrument-sans-latin-400-normal.woff"), weight: 400, style: "normal" },
    { name: "Instrument Sans", data: font("@fontsource/instrument-sans", "instrument-sans-latin-600-normal.woff"), weight: 600, style: "normal" },
    { name: "Instrument Sans", data: font("@fontsource/instrument-sans", "instrument-sans-latin-700-normal.woff"), weight: 700, style: "normal" },
    { name: "Newsreader", data: font("@fontsource/newsreader", "newsreader-latin-400-normal.woff"), weight: 400, style: "normal" },
  ]);

const INK = "#f4f3ef";
const MUTED = "#a3a29d";
const FAINT = "#6f6e6a";
const PAPER = "#0c0c0d";
const LINE = "#26262a";
const SIGNAL = "#7c8cff";
const LONG = "#3ecf8e";

const SERIES: Record<string, string> = { FEAR_GREED: "Fear & Greed", BTC_DOMINANCE: "BTC dominance", STABLECOIN_MCAP: "Stablecoin supply", TVL: "DeFi TVL" };
const KIND: Record<string, string> = {
  price: "Price",
  funding: "Funding",
  liquidity: "Liquidity",
  odds: "Prediction odds",
  token_onchain: "On-chain data",
  social: "Buzz on X",
  post_match: "Posts on X",
  news: "News",
  forecast: "Weather",
  model: "Forecast model",
  calendar: "Calendar",
  macro: "Rates and macro",
  yield: "DeFi yields",
  wallet: "A wallet",
  trader: "A Hyperliquid trader",
  sports: "Sports results",
  position: "Its own position",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).replace(/[\s,.;:–-]+\S*$/, "")}…` : t);

/** What the strategy listens to, in plain words, without repeats. */
export function watchesOf(s: Strategy): string[] {
  const out: string[] = [];
  for (const sig of s.signals) {
    let w = KIND[sig.kind] ?? sig.kind;
    if (sig.kind === "macro") {
      const up = sig.params.series.toUpperCase();
      w = SERIES[up] ?? (up.startsWith("FEES:") || up.startsWith("REVENUE:") ? "Protocol fees" : "Rates and macro");
    }
    if (sig.kind === "post_match") w = `Posts by ${sig.params.accounts.map((a) => `@${a.replace(/^@/, "")}`).slice(0, 2).join(", ")}`;
    if (sig.kind === "position") continue;
    if (!out.includes(w)) out.push(w);
  }
  for (const a of s.actions) if (a.type === "copy") out.push(a.leader.venue === "x" ? `Calls by @${a.leader.account}` : a.leader.venue === "solana" ? `Wallet ${short(a.leader.wallet)}` : `Trader ${short(a.leader.trader)}`);
  return out.slice(0, 4);
}

/** What it trades, as short market names. */
export function tradesOf(s: Strategy): string[] {
  const out: string[] = [];
  for (const a of s.actions) {
    let t: string | null = null;
    if (a.type === "open") {
      const i = a.instrument;
      t = i.kind === "perp" ? `${i.symbol}${a.leverage > 1 ? ` ${a.leverage}×` : ""}` : i.kind === "token" ? (i.symbol ? `$${i.symbol}` : "a Solana token") : i.kind === "outcome" ? "a prediction market" : instrumentLabel(i);
    } else if (a.type === "options") t = `${a.legs[0]!.instrument.underlying} options`;
    else if (a.type === "copy") t = a.leader.venue === "x" ? "every token it calls" : a.leader.venue === "solana" ? "every token it buys" : "every position it opens";
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 4);
}

type El = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown): El => ({ type, props: { style, children } });

const LOGO = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${INK}"/><g fill="none" stroke="${PAPER}" stroke-width="3.6" stroke-linecap="round"><path d="M8 13C20 13 21 24 30 24"/><path d="M8 24H30"/><path d="M8 35C20 35 21 24 30 24"/><path d="M30 24H40"/></g><circle cx="30" cy="24" r="5.2" fill="${PAPER}"/></svg>`
).toString("base64");

function row(label: string, items: string[], color: string): El {
  return h("div", { display: "flex", alignItems: "center", gap: 14, fontSize: 24 }, [
    h("div", { color: FAINT, width: 110 }, label),
    h("div", { display: "flex", gap: 10, flexWrap: "wrap" }, items.map((t) => h("div", { display: "flex", alignItems: "center", gap: 8, border: `1px solid ${LINE}`, borderRadius: 999, padding: "6px 16px", color: INK }, [h("div", { width: 9, height: 9, borderRadius: 9, background: color }), t]))),
  ]);
}

/** The 1200×630 card for a strategy, as PNG. */
export async function strategyCard(s: Strategy): Promise<Buffer> {
  const watches = watchesOf(s);
  const trades = tradesOf(s);
  // The renderer adds padding outside a box's size, so the frame is a fixed inner box with margins.
  const tree = h("div", { width: 1200, height: 630, display: "flex", background: PAPER, fontFamily: "Instrument Sans", color: INK }, [
   h("div", { width: 1056, height: 510, margin: "60px 72px", display: "flex", flexDirection: "column" }, [
    h("div", { display: "flex", alignItems: "center", gap: 14 }, [
      { type: "img", props: { src: `data:image/svg+xml;base64,${LOGO}`, width: 44, height: 44 } },
      h("div", { fontSize: 32, fontWeight: 600, letterSpacing: -1 }, "weft"),
      h("div", { marginLeft: "auto", fontSize: 24, color: MUTED }, "weft.fi"),
    ]),
    h("div", { display: "flex", flexDirection: "column", marginTop: 48 }, [
      h("div", { fontFamily: "Newsreader", fontSize: 76, lineHeight: 1.04, letterSpacing: -1.5 }, clip(s.name, 52)),
      h("div", { marginTop: 22, fontSize: 30, lineHeight: 1.4, color: MUTED }, clip(s.thesis, 150)),
    ]),
    h("div", { display: "flex", flexDirection: "column", gap: 14, marginTop: "auto" }, [
      ...(watches.length ? [row("Watches", watches, SIGNAL)] : []),
      ...(trades.length ? [row("Trades", trades, LONG)] : []),
    ]),
   ]),
  ]);
  const svg = await satori(tree as never, { width: 1200, height: 630, fonts: loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page a share link serves: Open Graph tags for crawlers, an instant hop to the strategy for people. */
export function sharePage(s: Strategy, id: string, site: string, o: { href?: string; image?: string; path?: string } = {}): string {
  const url = o.href ?? `${site}/strategy?id=${encodeURIComponent(id)}`;
  const image = o.image ?? `${site}/og/strategy/${encodeURIComponent(id)}.png`;
  const title = `${s.name} · Weft`;
  const desc = clip(s.thesis, 200);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Weft">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(`${site}/${o.path ?? "s"}/${encodeURIComponent(id)}`)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(url)}"><link rel="canonical" href="${esc(url)}">
</head><body style="background:${PAPER};color:${INK};font-family:system-ui,sans-serif"><script>location.replace(${JSON.stringify(url)})</script><p><a style="color:${INK}" href="${esc(url)}">Open ${esc(s.name)} on Weft</a></p></body></html>`;
}

/* ---------------- result cards: a run's outcome, shared by its owner ---------------- */

/**
 * A run's result, frozen when its owner shares it. Percent only, never amounts: what went in, the
 * wallet and the owner stay private. Practice runs say so on the card.
 */
export interface ResultCard {
  id: string;
  deploymentId: string;
  createdAt: number;
  practice: boolean;
  name: string;
  thesis: string;
  markets: string[];
  returnPct: number;
  /** Return in percent over time, oldest first. */
  curve: number[];
  since: number;
  trades: number;
  /** The strategy, so whoever opens the link can run the same thing. */
  strategy: Strategy;
  /** Highest leverage it trades at (1 when unlevered). */
  leverage?: number;
  /** Only when the owner chose to show amounts: what went in and what it made, USD. */
  amounts?: { investedUsd: number; pnlUsd: number } | null;
}

export type CardStyle = "print" | "receipt";

const UP = "#3ecf8e";
const DOWN = "#f26a57";
const fmtPct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString("en-US") : Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2)}%`;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const label = (t: string, color = FAINT) => h("div", { fontSize: 18, letterSpacing: 3, color, textTransform: "uppercase" }, t);

/** A smooth return line across the card's foot, with the zero line as a hairline. */
function curveSvg(curve: number[], w: number, hgt: number, color: string): string {
  const pts = curve.length >= 2 ? curve : [0, curve[0] ?? 0];
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * w, y = (v: number) => 6 + (1 - (v - lo) / span) * (hgt - 12);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${d} L${w} ${hgt} L0 ${hgt} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="${LINE}" stroke-width="2" stroke-dasharray="6 8"/><path d="${area}" fill="url(#g)"/><path d="${d}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/* ---------- result cards: two styles, set like Weft's printed graphics ---------- */

const here = dirname(new URL(import.meta.url).pathname);
const paperCache = new Map<string, string>();
/** Blank halftone paper (rendered once from Weft's banner system), as a data URL. */
const paper = (name: "green" | "pink" | "stone" | "cream") => {
  let v = paperCache.get(name);
  if (!v) {
    v = `data:image/jpeg;base64,${readFileSync(join(here, "../../assets/cards", `paper-${name}.jpg`)).toString("base64")}`;
    paperCache.set(name, v);
  }
  return v;
};
const DOTS = (() => {
  let c = "";
  for (let y = 11; y < 630; y += 22) for (let x = 11; x < 1200; x += 22) c += `<circle cx="${x}" cy="${y}" r="1.1"/>`;
  return `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><g fill="#2a2a2e">${c}</g></svg>`).toString("base64")}`;
})();
const MARK = (fg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g fill="none" stroke="${fg}" stroke-width="4.4" stroke-linecap="round"><path d="M8 13C20 13 21 24 30 24"/><path d="M8 24H30"/><path d="M8 35C20 35 21 24 30 24"/><path d="M30 24H40"/></g><circle cx="30" cy="24" r="5.6" fill="${fg}"/></svg>`).toString("base64")}`;
const img = (src: string, w: number, hh: number, style: Record<string, unknown> = {}): El => ({ type: "img", props: { src, width: w, height: hh, style } });
const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tradesTxt = (n: number) => `${n} ${n === 1 ? "trade" : "trades"}`;

/** Print: the run on the left, the return printed on a coloured slip (green up, pink down). */
function printCard(r: ResultCard): El {
  const tone = r.returnPct > 0 ? "green" : r.returnPct < 0 ? "pink" : "stone";
  const lev = r.leverage && r.leverage > 1 ? `${r.leverage}×` : null;
  const facts: [string, string][] = [
    ["Market", r.markets.slice(0, 2).join(" · ") || "—"],
    ...(r.amounts ? ([["Put in", `${usd(r.amounts.investedUsd)}${lev ? ` at ${lev}` : ""}`]] as [string, string][]) : lev ? ([["Leverage", lev]] as [string, string][]) : []),
    ["Since", day(r.since)],
  ];
  return h("div", { width: 1200, height: 630, display: "flex", position: "relative", background: "#0c0c0d", fontFamily: "Instrument Sans", color: INK }, [
    img(DOTS, 1200, 630, { position: "absolute", left: 0, top: 0 }),
    h("div", { position: "absolute", left: 56, top: 46, width: 480, height: 538, display: "flex", flexDirection: "column" }, [
      h("div", { display: "flex", alignItems: "center", gap: 12 }, [img(MARK(INK), 32, 32), h("div", { fontSize: 30, fontWeight: 600, letterSpacing: -1 }, "weft")]),
      h("div", { marginTop: 40, fontFamily: "Newsreader", fontSize: 50, lineHeight: 1.06, letterSpacing: -1 }, clip(r.name, 46)),
      h("div", { marginTop: 18, fontSize: 20, lineHeight: 1.45, color: MUTED }, `“${clip(r.thesis, 110)}”`),
      h("div", { marginTop: "auto", display: "flex", flexDirection: "column" }, [
        ...facts.map(([k, v]) =>
          h("div", { display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "11px 0", borderTop: `1px solid ${LINE}` }, [
            h("div", { fontSize: 13, letterSpacing: 2.4, color: FAINT, textTransform: "uppercase" }, k),
            h("div", { fontSize: 18, fontWeight: 600 }, v),
          ]),
        ),
        h("div", { marginTop: 16, fontSize: 18, fontWeight: 600 }, "weft.fi"),
      ]),
    ]),
    h("div", { position: "absolute", left: 580, top: 46, width: 564, height: 538, display: "flex" }, [
      img(paper(tone), 564, 538, { position: "absolute", left: 0, top: 0 }),
      h("div", { position: "absolute", left: 40, top: 34, right: 40, bottom: 34, display: "flex", flexDirection: "column", color: "#111" }, [
        h("div", { height: 22, fontSize: 16, fontWeight: 600, letterSpacing: 2.4, color: "#2e2e2e" }, r.practice ? "PRACTICE" : ""),
        h("div", { marginTop: 92, fontSize: fmtPct(r.returnPct).length > 7 ? 104 : 128, fontWeight: 700, letterSpacing: -5, lineHeight: 1 }, fmtPct(r.returnPct)),
        h("div", { marginTop: 34, height: 3, background: "#111", display: "flex" }),
        h("div", { marginTop: 26, fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }, r.amounts ? `${signedUsd(r.amounts.pnlUsd)} on ${usd(r.amounts.investedUsd)}` : tradesTxt(r.trades)),
        h("div", { marginTop: 8, fontSize: 21, color: "#2e2e2e" }, r.amounts ? `${tradesTxt(r.trades)} · since ${day(r.since)}` : `since ${day(r.since)}`),
      ]),
    ]),
  ]);
}

/** Receipt: the whole card is a printed slip, the return set large in serif. */
function receiptCard(r: ResultCard): El {
  const ink = "#111", dim = "#3a3936";
  const lev = r.leverage && r.leverage > 1 ? `${r.leverage}×` : "1×";
  const rows: [string, string][] = r.amounts
    ? [["Market", r.markets.slice(0, 2).join(" · ") || "—"], ["Put in", `${usd(r.amounts.investedUsd)} at ${lev}`], ["Result", signedUsd(r.amounts.pnlUsd)], ["Since", day(r.since)]]
    : [["Market", r.markets.slice(0, 2).join(" · ") || "—"], ["Leverage", lev], ["Trades", String(r.trades)], ["Since", day(r.since)]];
  return h("div", { width: 1200, height: 630, display: "flex", position: "relative", fontFamily: "Instrument Sans", color: ink }, [
    img(paper("cream"), 1200, 630, { position: "absolute", left: 0, top: 0 }),
    h("div", { position: "absolute", left: 56, top: 44, right: 56, bottom: 40, display: "flex", flexDirection: "column" }, [
      h("div", { display: "flex", alignItems: "center", gap: 12, paddingBottom: 18, borderBottom: `2px solid ${ink}` }, [
        img(MARK(ink), 30, 30),
        h("div", { fontSize: 28, fontWeight: 600, letterSpacing: -1 }, "weft"),
        h("div", { marginLeft: "auto", fontSize: 15, fontWeight: 600, letterSpacing: 2.4, color: dim }, r.practice ? "PRACTICE" : ""),
      ]),
      h("div", { marginTop: 22, fontFamily: "Newsreader", fontSize: 34, letterSpacing: -0.5 }, clip(r.name, 60)),
      h("div", { marginTop: 4, fontFamily: "Newsreader", fontSize: 150, lineHeight: 1, letterSpacing: -4, color: r.returnPct < 0 ? "#a3261b" : ink }, fmtPct(r.returnPct)),
      h("div", { marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }, rows.map(([k, v]) =>
        h("div", { display: "flex", alignItems: "flex-end", gap: 16 }, [
          h("div", { width: 120, fontSize: 15, fontWeight: 600, letterSpacing: 2, color: dim, textTransform: "uppercase" }, k),
          h("div", { flex: 1, height: 12, borderBottom: `2px dashed ${dim}`, display: "flex" }),
          h("div", { fontSize: 20, fontWeight: 600 }, v),
        ]),
      )),
      h("div", { marginTop: "auto", display: "flex", alignItems: "baseline", justifyContent: "space-between" }, [
        h("div", { fontFamily: "Newsreader", fontSize: 20, color: dim }, `“${clip(r.thesis, 90)}”`),
        h("div", { fontSize: 20, fontWeight: 700 }, "weft.fi"),
      ]),
    ]),
  ]);
}

/** A 1200×630 result card, as PNG, in either style. */
export async function resultCard(r: ResultCard, style: CardStyle = "print"): Promise<Buffer> {
  const tree = style === "receipt" ? receiptCard(r) : printCard(r);
  const svg = await satori(tree as never, { width: 1200, height: 630, fonts: loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}

/** The page a result link serves: its card for crawlers, the same strategy (ready to run) for people. */
export function resultPage(r: ResultCard, site: string): string {
  const url = `${site}/new?from=${encodeURIComponent(`result:${r.id}`)}`;
  const image = `${site}/og/result/${encodeURIComponent(r.id)}.png`;
  const title = `${r.name}: ${fmtPct(r.returnPct)}${r.practice ? " in practice" : ""} · Weft`;
  const desc = clip(r.thesis, 200);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Weft">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(`${site}/r/${encodeURIComponent(r.id)}`)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@weftfinance"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(url)}"><link rel="canonical" href="${esc(url)}">
</head><body style="background:${PAPER};color:${INK};font-family:system-ui,sans-serif"><script>location.replace(${JSON.stringify(url)})</script><p><a style="color:${INK}" href="${esc(url)}">Run ${esc(r.name)} on Weft</a></p></body></html>`;
}
