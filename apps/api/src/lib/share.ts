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
export function sharePage(s: Strategy, id: string, site: string): string {
  const url = `${site}/strategy?id=${encodeURIComponent(id)}`;
  const image = `${site}/og/strategy/${encodeURIComponent(id)}.png`;
  const title = `${s.name} · Weft`;
  const desc = clip(s.thesis, 200);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Weft">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(`${site}/s/${encodeURIComponent(id)}`)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(url)}"><link rel="canonical" href="${esc(url)}">
</head><body style="background:${PAPER};color:${INK};font-family:system-ui,sans-serif"><script>location.replace(${JSON.stringify(url)})</script><p><a style="color:${INK}" href="${esc(url)}">Open ${esc(s.name)} on Weft</a></p></body></html>`;
}
