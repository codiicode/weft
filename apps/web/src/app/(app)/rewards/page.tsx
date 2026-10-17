"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, fmtUsd } from "@/lib/use-api";
import { PageHeader, Card, Btn } from "@/components/app/AppShell";
import { brand, $T } from "@/config/brand";

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const REWARDS_TOKEN_FEE = { buybackBps: brand.tokenFee.buybackBps };
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function Stat({ label, value, sub, action }: { label: string; value: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col bg-card p-5">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="tnum mt-1.5 text-[26px] font-semibold tracking-[-0.03em] text-ink">{value}</div>
      {sub && <div className="mt-2 text-[12.5px] text-muted">{sub}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Daily $WEFT rewards: what you've earned from trading and from your strategies, and claiming it. */
export default function RewardsPage() {
  const auth = useAuth();
  const program = useApi(() => api.rewards(), [], { pollMs: 120_000 });
  const signedIn = !auth.enabled || auth.authenticated;
  const mine = useApi(signedIn ? () => api.myRewards() : null, [signedIn], { pollMs: 60_000 });
  const [claim, setClaim] = useState<{ busy?: boolean; msg?: string; tx?: string; err?: string }>({});
  const p = program.data, m = mine.data, cfg = brand.rewards;

  const doClaim = async () => {
    setClaim({ busy: true });
    try {
      const r = await api.claimRewards();
      setClaim({ msg: `Sent ${tokens(r.tokens)} ${$T} to your wallet.`, tx: r.tx });
      void mine.refresh();
    } catch (e) {
      setClaim({ err: (e as Error).message });
    }
  };

  const tier = m?.holder?.tier ?? 0;
  const boost = [1, cfg.holderBoost, cfg.bigHolderBoost][tier]!;
  return (
    <>
      <PageHeader title="Rewards" sub={`Half of every fee Weft earns buys ${$T}. Every day, ${pct(cfg.traderShare)} of it goes back to the people who traded and ${pct(cfg.creatorShare)} to the people whose strategies they ran.`} />
      <div className="space-y-6 px-5 pb-16 pt-6 lg:px-10">
        {p && !p.enabled && (
          <Card className="p-5 text-[14px] leading-relaxed text-ink-2">
            Rewards start the day {$T} launches. From then on, each day closes at midnight UTC and its rewards are ready to claim shortly after.
          </Card>
        )}

        {signedIn ? (
          <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Ready to claim"
              value={m ? `${tokens(m.claimableTokens)} ${$T}` : "—"}
              sub={m?.wallet ? `To ${m.wallet.slice(0, 4)}…${m.wallet.slice(-4)}` : "Set up a Solana wallet under Trading accounts to receive rewards"}
              action={
                <Btn onClick={doClaim} disabled={!m?.claims || !m.claimableTokens || !m.wallet || claim.busy}>
                  {claim.busy ? "Sending…" : "Claim"}
                </Btn>
              }
            />
            <Stat
              label="Today so far"
              value={m ? fmtUsd(m.today.feesPaidUsd, 2) : "—"}
              sub={m && m.today.feesPaidUsd > 0 ? `in fees · your share of today’s pot so far: ${tokens(m.today.estTradeTokens * boost)} ${$T}${m.priceUsd ? ` (${fmtUsd(m.today.estTradeTokens * boost * m.priceUsd, 2)})` : ""}` : "in fees paid on live trades"}
            />
            <Stat
              label="From your strategies"
              value={m ? fmtUsd(m.today.creatorFeesUsd, 2) : "—"}
              sub={m && m.today.creatorFeesUsd > 0 ? `paid by other people’s runs today · your share so far: ${tokens(m.today.estCreateTokens)} ${$T}` : "Publish a strategy; you earn when others run it"}
            />
            <Stat
              label="Your boost"
              value={`${boost}×`}
              sub={tier === 2 ? "Largest holders" : tier === 1 ? `Holder · ${cfg.bigHolderBoost}× from ${tokens(m!.holder!.bigAmount)} ${$T}` : m?.holder ? `Hold ${tokens(m.holder.minAmount)} ${$T} for ${cfg.holderBoost}×` : `Hold ${$T} for ${cfg.holderBoost}×, or ${cfg.bigHolderBoost}× as a large holder`}
            />
          </div>
        ) : (
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <p className="text-[14px] text-ink-2">Sign in to see what you’ve earned.</p>
            <Btn onClick={auth.login}>Sign in</Btn>
          </Card>
        )}
        {(claim.msg || claim.err) && (
          <p className={`text-[13.5px] ${claim.err ? "text-short" : "text-ink-2"}`}>
            {claim.err ?? claim.msg}{" "}
            {claim.tx && (
              <a className="underline decoration-line-2 underline-offset-4" href={`https://solscan.io/tx/${claim.tx}`} target="_blank" rel="noopener noreferrer">
                View ↗
              </a>
            )}
          </p>
        )}

        {m && m.history.length > 0 && (
          <section>
            <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.015em] text-ink">Your rewards</h2>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13.5px]">
                <thead className="text-left text-[12.5px] text-muted">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2.5 font-normal">Day</th>
                    <th className="px-3 py-2.5 font-normal">From</th>
                    <th className="px-3 py-2.5 text-right font-normal">Fees</th>
                    <th className="px-3 py-2.5 text-right font-normal">Reward</th>
                    <th className="px-5 py-2.5 text-right font-normal">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {m.history.map((r) => (
                    <tr key={`${r.day}-${r.kind}`}>
                      <td className="px-5 py-2.5 text-ink-2">{dayLabel(r.day)}</td>
                      <td className="px-3 py-2.5 text-ink-2">{r.kind === "trade" ? "Your trades" : "Your strategies"}</td>
                      <td className="tnum px-3 py-2.5 text-right text-ink-2">{fmtUsd(r.basisUsd, 2)}</td>
                      <td className="tnum px-3 py-2.5 text-right text-ink">{tokens(r.tokens)} {$T}</td>
                      <td className="px-5 py-2.5 text-right text-[12.5px]">
                        {r.claimTx && !r.claimTx.startsWith("pending") ? (
                          <a className="text-ink underline decoration-line-2 underline-offset-4" href={`https://solscan.io/tx/${r.claimTx}`} target="_blank" rel="noopener noreferrer">Claimed ↗</a>
                        ) : r.tokens > 0 ? (
                          <span className="text-long">Ready</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.015em] text-ink">How it works</h2>
          <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line md:grid-cols-3">
            {[
              [`${pct(cfg.traderShare)} to traders`, "Split by the fees each person paid that day, times their holder boost. It’s based on fees, not volume, so trading only for the reward always costs more than it pays."],
              [`${pct(cfg.creatorShare)} to creators`, "When other people run a strategy you published (or a copy of it), you get a share by the fees their runs paid. Your own runs don’t count."],
              [`${pct(cfg.burnShare)} burned`, `Burned the same day. Nothing new is ever minted, so the ${$T} supply only shrinks.`],
            ].map(([k, v]) => (
              <div key={k} className="bg-card p-5">
                <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">{k}</div>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{v}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
            {$T} is bought in small amounts about every ten minutes, all day: the {(REWARDS_TOKEN_FEE.buybackBps / 100).toFixed(1)}% buyback on every {$T} trade, and half of Weft’s strategy fees from the day before. Each day’s pots are shared out at midnight UTC and can be claimed right after. Holders also pay half the fee and get {p?.aiDailyLimit.holders ?? brand.aiDrafts.holders} AI drafts a day instead of {p?.aiDailyLimit.everyone ?? brand.aiDrafts.everyone}.
          </p>
        </section>

        {p?.stats && p.stats.buys > 0 && (
          <section>
            <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.015em] text-ink">Everyone</h2>
            <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Bought back" value={`${tokens(p.stats.boughtTokens)} ${$T}`} sub={`for ${fmtUsd(p.stats.spentUsd, 2)} in ${p.stats.buys.toLocaleString()} buys`} />
              <Stat label="Burned" value={`${tokens(p.stats.burnedTokens)} ${$T}`} />
              <Stat label="Shared out" value={`${tokens(p.stats.sharedTokens)} ${$T}`} sub={`${p.stats.daysClosed} days`} />
              <Stat label="Today’s pot so far" value={`${tokens(p.stats.todayPotTokens)} ${$T}`} sub={p.stats.lastBuyAt ? `last buy ${Math.max(1, Math.round((Date.now() - p.stats.lastBuyAt) / 60_000))} min ago` : undefined} />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
