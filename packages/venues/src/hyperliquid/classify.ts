import type { AssetClass } from "@weft/strategy";

/**
 * Asset-class classification for HIP-3 builder-dex markets. Hyperliquid does
 * not tag markets, so this is a static map of known tickers plus heuristics:
 *  1. explicit commodity / fx / index / rates / crypto sets below
 *  2. a symbol that also trades as a core (crypto) perp → crypto
 *  3. anything else on a builder dex → equity (most HIP-3 listings are stocks,
 *     ETFs or pre-IPO companies)
 */

const COMMODITY = new Set([
  "GOLD", "SILVER", "PLATINUM", "PALLADIUM", "COPPER", "ALUMINIUM", "ALUMINUM", "NICKEL", "ZINC", "URANIUM",
  "CL", "WTI", "OIL", "USOIL", "BRENTOIL", "BRENT", "NATGAS", "GAS", "TTF", "HO", "RBOB", "GASOLINE",
  "CORN", "WHEAT", "SOY", "SOYBEAN", "SUGAR", "COFFEE", "COCOA", "COTTON", "CATTLE", "HOGS", "OJ",
  "GOLDJM", "SILVERJM", "LITHIUM", "IRONORE",
]);

const FX = new Set(["EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "NZD", "CNH", "CNY", "KRW", "INR", "BRL", "MXN", "TRY", "DXY", "USDX"]);

const INDEX = new Set([
  "SP500", "US500", "USA500", "SPX", "XYZ100", "USA100", "USTECH", "NDX", "NAS100", "US30", "DJI", "SMALL2000", "RUT",
  "JP225", "JPN225", "NIKKEI", "KR200", "KOSPI", "NIFTY", "IBOV", "BRAZIL50", "HSI", "DAX", "FTSE", "CAC40", "STOXX50",
  "MAG7", "SEMIS", "SEMI", "ROBOT", "INFOTECH", "NUCLEAR", "DEFENSE", "ENERGY", "BIOTECH", "USENERGY", "GLDMINE",
  "VIX", "VOL", "BVIV",
]);

/** Rates / bonds / compute-price style markets with no better bucket. */
const OTHER = new Set(["USBOND", "2Y", "10Y", "30Y", "US2Y", "US10Y", "H100", "TREAD"]);

/** Crypto aggregates that don't exist as core perps. */
const CRYPTO = new Set(["TOTAL2", "OTHERS", "BTCD", "USDE", "ANSEM"]);

/** Display names for common tickers so search by company name works. */
export const KNOWN_NAMES: Record<string, string> = {
  NVDA: "NVIDIA", TSLA: "Tesla", AAPL: "Apple", MSFT: "Microsoft", GOOGL: "Alphabet (Google)", GOOG: "Alphabet (Google)",
  AMZN: "Amazon", META: "Meta Platforms", NFLX: "Netflix", AMD: "Advanced Micro Devices", INTC: "Intel", MU: "Micron",
  PLTR: "Palantir", COIN: "Coinbase", HOOD: "Robinhood", MSTR: "Strategy (MicroStrategy)", CRCL: "Circle", ORCL: "Oracle",
  AVGO: "Broadcom", TSM: "TSMC", ASML: "ASML", ARM: "Arm Holdings", QCOM: "Qualcomm", AMAT: "Applied Materials",
  LRCX: "Lam Research", MRVL: "Marvell", SNDK: "SanDisk", WDC: "Western Digital", DELL: "Dell", IBM: "IBM",
  BABA: "Alibaba", TENCENT: "Tencent", TCNT: "Tencent", XIAOMI: "Xiaomi", SMSN: "Samsung Electronics", SKHX: "SK Hynix",
  SKHY: "SK Hynix", HYUNDAI: "Hyundai", SOFTBANK: "SoftBank", KIOXIA: "Kioxia", GME: "GameStop", RIVN: "Rivian",
  LLY: "Eli Lilly", COST: "Costco", CRWD: "CrowdStrike", NET: "Cloudflare", RDDT: "Reddit", RKLB: "Rocket Lab",
  HIMS: "Hims & Hers", DKNG: "DraftKings", EBAY: "eBay", ZM: "Zoom", NOW: "ServiceNow", NBIS: "Nebius", IREN: "IREN",
  CRWV: "CoreWeave", BMNR: "BitMine", MRNA: "Moderna", CVX: "Chevron", GEV: "GE Vernova", ACN: "Accenture",
  SPACEX: "SpaceX (pre-IPO)", SPCX: "SpaceX (pre-IPO)", OPENAI: "OpenAI (pre-IPO)", OAI: "OpenAI (pre-IPO)",
  ANTHROPIC: "Anthropic (pre-IPO)", ANTH: "Anthropic (pre-IPO)", SHEIN: "Shein (pre-IPO)",
  GOLD: "Gold", SILVER: "Silver", CL: "WTI crude oil", WTI: "WTI crude oil", USOIL: "WTI crude oil", OIL: "Crude oil",
  BRENTOIL: "Brent crude oil", NATGAS: "Natural gas", GAS: "Natural gas", COPPER: "Copper", PLATINUM: "Platinum",
  PALLADIUM: "Palladium", URANIUM: "Uranium", ALUMINIUM: "Aluminium", CORN: "Corn", WHEAT: "Wheat", SOY: "Soybeans",
  SUGAR: "Sugar", TTF: "Dutch TTF gas", HO: "Heating oil",
  SP500: "S&P 500", US500: "S&P 500", USA500: "S&P 500", XYZ100: "Nasdaq-100 (XYZ100)", USA100: "Nasdaq-100", USTECH: "Nasdaq-100",
  SMALL2000: "Russell 2000", JP225: "Nikkei 225", JPN225: "Nikkei 225", KR200: "KOSPI 200", NIFTY: "Nifty 50",
  IBOV: "Ibovespa", BRAZIL50: "Brazil 50", VIX: "VIX volatility index", DXY: "US Dollar Index",
  EUR: "Euro / USD", JPY: "Japanese yen", GBP: "British pound", KRW: "Korean won",
  EWY: "iShares MSCI South Korea ETF", EWJ: "iShares MSCI Japan ETF", EWZ: "iShares MSCI Brazil ETF", EWT: "iShares MSCI Taiwan ETF",
  SMH: "VanEck Semiconductor ETF", SOXL: "Direxion Semiconductor Bull 3x", XLE: "Energy Select SPDR", XBI: "SPDR Biotech ETF",
  TLT: "iShares 20+ Year Treasury ETF", KWEB: "KraneShares China Internet ETF",
};

export function classifyHip3(symbol: string, coreSymbols?: ReadonlySet<string>): AssetClass {
  const s = symbol.toUpperCase();
  if (COMMODITY.has(s)) return "commodity";
  if (FX.has(s)) return "fx";
  if (INDEX.has(s)) return "index";
  if (OTHER.has(s)) return "other";
  if (CRYPTO.has(s)) return "crypto";
  if (KNOWN_NAMES[s]) return "equity";
  if (coreSymbols?.has(s) || coreSymbols?.has(`k${s.replace(/^1000/, "")}`) || /^1000[A-Z]/.test(s)) return "crypto";
  return "equity";
}
