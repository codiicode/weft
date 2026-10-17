import type { Signal, SignalKind, SignalSnapshot } from "@weft/strategy";
import type { SignalProvider } from "../types.ts";
import type { VenueMarketData } from "../market-data.ts";
import { fetchTokenOnchain } from "../tokens.ts";
import { calendarProvider } from "./calendar.ts";
import { defineProvider } from "./common.ts";
import { externalProviders, type ExternalUrls } from "./external.ts";
import { marketProviders } from "./market.ts";
import { newsProvider } from "./news.ts";
import { xProviders } from "./x.ts";
import { walletProvider } from "./wallet.ts";
import { traderProvider } from "./trader.ts";
import { simulatedProviders } from "./simulated.ts";

export function createSignalProviders(md: VenueMarketData, urls: ExternalUrls = {}, onError?: (kind: string, err: unknown) => void): SignalProvider[] {
  return [
    ...marketProviders(md, onError),
    defineProvider(["token_onchain"], "live", (s, now) => fetchTokenOnchain(md, s.params.mint, now), onError),
    ...externalProviders(md.ctx.http, urls, onError),
    // Ahead of the simulated providers, so these kinds are live.
    newsProvider(md.ctx.http, undefined, onError),
    ...(md.ctx.opts.twitterApiKey ? xProviders(md.ctx.http, md.ctx.opts.twitterApiKey, { matcher: md.ctx.opts.postMatcher, onError }) : []),
    ...(md.ctx.helius ? [walletProvider(md.ctx.helius, onError)] : []),
    traderProvider(md.ctx.hl, onError),
    calendarProvider(),
    ...simulatedProviders({
      marketProb: async (i) => {
        const q = await md.getQuote(i);
        return q.price;
      },
    }),
  ];
}

/**
 * Dispatches a signal to the provider that handles its kind. `position` is
 * produced by the engine (from its own book), so it is not handled here.
 */
export class SignalRouter {
  private readonly byKind = new Map<SignalKind, SignalProvider>();

  readonly providers: readonly SignalProvider[];

  constructor(providers: readonly SignalProvider[]) {
    this.providers = providers;
    for (const p of providers) for (const k of p.kinds) if (!this.byKind.has(k)) this.byKind.set(k, p);
  }

  providerFor(kind: SignalKind): SignalProvider | undefined {
    return this.byKind.get(kind);
  }

  modeOf(kind: SignalKind): "live" | "simulated" | undefined {
    return this.byKind.get(kind)?.mode;
  }

  async fetch(signal: Signal, now: number): Promise<SignalSnapshot | null> {
    const p = this.byKind.get(signal.kind);
    if (!p) return null;
    try {
      return await p.fetch(signal, now);
    } catch {
      return null;
    }
  }

  /** Fetch many signals concurrently; result keyed by signal id. */
  async fetchAll(signals: readonly Signal[], now: number): Promise<Record<string, SignalSnapshot | undefined>> {
    const entries = await Promise.all(signals.map(async (s) => [s.id, (await this.fetch(s, now)) ?? undefined] as const));
    return Object.fromEntries(entries);
  }
}
