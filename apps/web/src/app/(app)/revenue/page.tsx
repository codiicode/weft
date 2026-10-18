"use client";
import { api, type Earnings } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, fmtUsd } from "@/lib/use-api";
import { PageHeader, Card, Empty } from "@/components/app/AppShell";
import { $T } from "@/config/brand";

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A shortened address that opens in the chain's explorer, so anyone can check the figures. */
function Addr({ a, href }: { a: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-4 hover:text-ink">
      {short(a)} ↗
    </a>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card p-5">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="tnum mt-1.5 text-[26px] font-semibold tracking-[-0.03em] text-ink">{value}</div>
      {sub && <div className="mt-2 text-[12.5px] text-muted">{sub}</div>}
    </div>
  );
}

type BuyEvent = Earnings["buybacks"]["events"][number];
const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const txLink = (sig: string, label: string) => (
  <a className="text-ink underline decoration-line-2 underline-offset-4" href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noopener noreferrer">
    {label} ↗
  </a>
);

/** Every burn: the launch burn, then each day's buybacks (open a day to see each buy and its burn). */
function BurnLog({ events, launch }: { events: BuyEvent[]; launch: Earnings["buybacks"]["launchBurn"] }) {
  const days = new Map<string, BuyEvent[]>();
  for (const ev of events) days.set(day(ev.at), [...(days.get(day(ev.at)) ?? []), ev]);
  return (
    <Card className="mt-4 overflow-hidden">
      <ul className="divide-y divide-line text-[13.5px]">
        {[...days].map(([d, list]) => {
          const bought = list.reduce((n, e) => n + e.boughtTokens, 0), spent = list.reduce((n, e) => n + e.spentUsd, 0), burned = list.reduce((n, e) => n + (e.burnedTokens ?? 0), 0);
          return (
            <li key={d}>
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-5 py-3 hover:bg-paper-2 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2.5 text-muted">
                    <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" className="transition-transform group-open:rotate-90"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    {d}
                  </span>
                  <span className="tnum text-ink">
                    {list.length} buyback{list.length === 1 ? "" : "s"} · {tokens(bought)} {$T} for {fmtUsd(spent, 2)}
                    <span className="text-muted"> · {tokens(burned)} burned</span>
                  </span>
                </summary>
                <ul className="divide-y divide-line border-t border-line bg-paper-2/50">
                  {list.map((ev, i) => (
                    <li key={`${ev.at}-${ev.tx}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2 pl-11 text-[13px]">
                      <span className="tnum text-muted">{time(ev.at)} UTC</span>
                      <span className="tnum text-ink-2">
                        {tokens(ev.boughtTokens)} for {fmtUsd(ev.spentUsd, 2)}
                        {ev.burnedTokens ? <span className="text-muted"> · {tokens(ev.burnedTokens)} burned</span> : null}
                      </span>
                      <span className="flex gap-3 text-[12.5px]">
                        {ev.tx && txLink(ev.tx, "Buy")}
                        {ev.burnTx && txLink(ev.burnTx, "Burn")}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
        {launch && (
          <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <span className="pl-[22px] text-muted">{day(launch.at)}</span>
            <span className="tnum text-ink">
              Launch: Weft’s dev buy, all burned<span className="text-muted"> · {tokens(launch.tokens)} burned</span>
            </span>
            <span className="text-[12.5px]">{txLink(launch.tx, "Burn")}</span>
          </li>
        )}
      </ul>
    </Card>
  );
}

/** Protocol revenue: what Weft has earned in fees, how it splits, and the $WEFT buybacks. Public; owners also see the operating details. */
export default function RevenuePage() {
  const auth = useAuth();
  const e = useApi(() => api.revenue(), [], { pollMs: 60_000 });
  const me = useApi(auth.enabled && auth.authenticated ? () => api.me() : null, [auth.authenticated]);
  const owner = Boolean(me.data?.isAdmin);
  const d = e.data;
  return (
    <>
      <PageHeader title="Protocol revenue" sub="Weft’s fees from every trade, and how they split." />
      <div className="space-y-6 px-5 pb-16 pt-6 lg:px-10">
        {e.error && !d ? (
          <Empty title="Couldn’t load revenue" sub="Try again in a minute." />
        ) : !d ? (
          <div className="h-40 animate-pulse rounded-[12px] bg-paper-2" />
        ) : (
          <>
            <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-3">
              <Stat label="Revenue so far" value={fmtUsd(d.totalUsd, 2)} sub={d.token ? `Fees on ${$T} trades + Hyperliquid + Solana swaps` : "Hyperliquid builder fees + Solana swap fees"} />
              <Stat label={`For ${$T} buybacks`} value={fmtUsd(d.buybackUsd, 2)} sub={d.token ? `0.4% of every ${$T} trade + half of all other fees` : "Half of all fees"} />
              <Stat label="Weft’s share" value={fmtUsd(d.weftUsd, 2)} sub={d.token ? `2% of every ${$T} trade + the other half` : "The other half"} />
            </div>
            <div className={`grid gap-4 ${d.token ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
              {d.token && (
                <Card className="p-5">
                  <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Fees on {$T} trades</div>
                  <dl className="mt-3 grid grid-cols-2 gap-y-2 text-[13.5px]">
                    <dt className="text-muted">Claimed</dt>
                    <dd className="tnum text-right text-ink">
                      {d.token.claimedSol.toFixed(2)} SOL<span className="text-muted"> · {fmtUsd(d.token.claimedUsd, 0)}</span>
                    </dd>
                    <dt className="text-muted">To Weft (2%)</dt>
                    <dd className="tnum text-right text-ink">{d.token.protocolSol.toFixed(2)} SOL</dd>
                    <dt className="text-muted">To buybacks (0.4%)</dt>
                    <dd className="tnum text-right text-ink">{d.token.buybackSol.toFixed(2)} SOL</dd>
                    {d.token.treasury && (
                      <>
                        <dt className="text-muted">Treasury</dt>
                        <dd className="tnum text-right text-ink-2"><Addr href={`https://solscan.io/account/${d.token.treasury}`} a={d.token.treasury} /></dd>
                      </>
                    )}
                  </dl>
                  <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
                    Every {$T} trade pays 3%: 0.6% to Meteora, the rest claimed about every ten minutes. In dollars at today’s SOL price.
                  </p>
                </Card>
              )}
              <Card className="p-5">
                <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Hyperliquid</div>
                {d.hyperliquid ? (
                  <dl className="mt-3 grid grid-cols-2 gap-y-2 text-[13.5px]">
                    <dt className="text-muted">Builder fees earned</dt>
                    <dd className="tnum text-right text-ink">{fmtUsd(d.hyperliquid.earnedUsd, 2)}</dd>
                    <dt className="text-muted">Ready to claim</dt>
                    <dd className="tnum text-right text-ink">{fmtUsd(d.hyperliquid.unclaimedUsd, 2)}</dd>
                    <dt className="text-muted">Claimed</dt>
                    <dd className="tnum text-right text-ink">{fmtUsd(d.hyperliquid.claimedUsd, 2)}</dd>
                    <dt className="text-muted">Builder account</dt>
                    <dd className="tnum text-right text-ink-2">{fmtUsd(d.hyperliquid.accountValueUsd, 2)} · <Addr href={`https://hypurrscan.io/address/${d.hyperliquid.builder}`} a={d.hyperliquid.builder} /></dd>
                  </dl>
                ) : (
                  <p className="mt-2 text-[13px] text-muted">No builder address set.</p>
                )}
                {owner && <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
                  Fees build up on Hyperliquid and are claimed into the builder account with <code className="font-mono">scripts/claim-builder-fees.ts --send</code>.
                </p>}
              </Card>
              <Card className="p-5">
                <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Solana</div>
                {d.solana ? (
                  <dl className="mt-3 grid grid-cols-2 gap-y-2 text-[13.5px]">
                    <dt className="text-muted">Fees in SOL</dt>
                    <dd className="tnum text-right text-ink">
                      {d.solana.wsol.toFixed(4)} SOL{d.solana.solUsd != null && <span className="text-muted"> · {fmtUsd(d.solana.wsol * d.solana.solUsd, 2)}</span>}
                    </dd>
                    <dt className="text-muted">Fees in USDC</dt>
                    <dd className="tnum text-right text-ink">{fmtUsd(d.solana.usdc, 2)}</dd>
                    <dt className="text-muted">Fee wallet</dt>
                    <dd className="tnum text-right text-ink-2"><Addr href={`https://solscan.io/account/${d.solana.feeWallet}`} a={d.solana.feeWallet} /></dd>
                    {owner && (
                      <>
                        <dt className="text-muted">SOL in the wallet</dt>
                        <dd className="tnum text-right text-ink-2">{d.solana.sol.toFixed(4)} SOL</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="mt-2 text-[13px] text-muted">No fee wallet set.</p>
                )}
              </Card>
            </div>
            <section>
              <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.015em] text-ink">{$T} buybacks</h2>
              <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-3">
                <Stat
                  label="Bought back"
                  value={d.buybacks.boughtTokens > 0 ? `${tokens(d.buybacks.boughtTokens)} ${$T}` : "—"}
                  sub={d.buybacks.spentUsd > 0 ? `for ${fmtUsd(d.buybacks.spentUsd, 2)} of fees` : "Nothing bought yet"}
                />
                <Stat
                  label="Burned"
                  value={d.buybacks.burnedTokens > 0 ? `${tokens(d.buybacks.burnedTokens)} ${$T}` : "—"}
                  sub={
                    d.buybacks.initialSupply && d.buybacks.burnedTokens > 0
                      ? `${((d.buybacks.burnedTokens / d.buybacks.initialSupply) * 100).toFixed(3)}% of the supply, gone for good`
                      : "Read from the chain: supply at launch minus supply now"
                  }
                />
                <Stat label="Waiting to be bought" value={fmtUsd(d.buybacks.setAsideUsd, 2)} sub={d.buybacks.mint ? "Held in the treasury until the next buyback, a few minutes away" : `Buybacks start when ${$T} launches`} />
              </div>
              {(d.buybacks.events.length > 0 || d.buybacks.launchBurn) && <BurnLog events={d.buybacks.events} launch={d.buybacks.launchBurn} />}
            </section>

            {owner && <p className="text-[12.5px] text-faint">
              Weft’s own records of fees paid by live runs: {fmtUsd(d.recordedUsd, 2)}. The venue figures above are what actually arrived.
            </p>}
          </>
        )}
      </div>
    </>
  );
}
