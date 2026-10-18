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
let fonts: { name: string; data: Buffer; weight: 400 | 600; style: "normal" }[] | null = null;
const loadFonts = () =>
  (fonts ??= [
    { name: "Instrument Sans", data: font("@fontsource/instrument-sans", "instrument-sans-latin-400-normal.woff"), weight: 400, style: "normal" },
    { name: "Instrument Sans", data: font("@fontsource/instrument-sans", "instrument-sans-latin-600-normal.woff"), weight: 600, style: "normal" },
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
  for (const a of s.actions) if (a.type === "copy") out.push(a.leader.venue === "solana" ? `Wallet ${short(a.leader.wallet)}` : `Trader ${short(a.leader.trader)}`);
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
    else if (a.type === "copy") t = a.leader.venue === "solana" ? "every token it buys" : "every position it opens";
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
}

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

/** The 1200×630 result card, as PNG. */
export async function resultCard(r: ResultCard): Promise<Buffer> {
  const color = r.returnPct > 0 ? UP : r.returnPct < 0 ? DOWN : INK;
  const curve = Buffer.from(curveSvg(r.curve, 1056, 150, color === INK ? MUTED : color)).toString("base64");
  const tree = h("div", { width: 1200, height: 630, display: "flex", background: PAPER, fontFamily: "Instrument Sans", color: INK }, [
    h("div", { width: 1056, height: 510, margin: "60px 72px", display: "flex", flexDirection: "column" }, [
      h("div", { display: "flex", alignItems: "center", gap: 14 }, [
        { type: "img", props: { src: `data:image/svg+xml;base64,${LOGO}`, width: 44, height: 44 } },
        h("div", { fontSize: 32, fontWeight: 600, letterSpacing: -1 }, "weft"),
        h("div", { marginLeft: "auto", display: "flex" }, [label(r.practice ? "Practice · pretend money" : "Live · real money", r.practice ? "#f5a524" : MUTED)]),
      ]),
      h("div", { display: "flex", marginTop: 44, gap: 48 }, [
        h("div", { display: "flex", flexDirection: "column", flex: 1 }, [
          h("div", { fontFamily: "Newsreader", fontSize: 60, lineHeight: 1.05, letterSpacing: -1.2 }, clip(r.name, 44)),
          h("div", { marginTop: 18, fontSize: 25, lineHeight: 1.4, color: MUTED }, clip(r.thesis, 120)),
        ]),
        h("div", { display: "flex", flexDirection: "column", alignItems: "flex-end" }, [
          label("Return"),
          h("div", { fontSize: 104, fontWeight: 600, letterSpacing: -4, lineHeight: 1.05, color, marginTop: 6 }, fmtPct(r.returnPct)),
          h("div", { fontSize: 21, color: FAINT, marginTop: 4 }, `since ${day(r.since)} · ${r.trades} ${r.trades === 1 ? "trade" : "trades"}`),
        ]),
      ]),
      h("div", { display: "flex", marginTop: "auto", flexDirection: "column" }, [
        { type: "img", props: { src: `data:image/svg+xml;base64,${curve}`, width: 1056, height: 150 } },
        h("div", { display: "flex", alignItems: "center", gap: 18, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${LINE}` }, [
          label("Trades"),
          h("div", { fontSize: 22, color: INK }, r.markets.join("  ·  ") || "—"),
          h("div", { marginLeft: "auto", fontSize: 22, color: MUTED }, "Made with Weft · weft.fi"),
        ]),
      ]),
    ]),
  ]);
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
