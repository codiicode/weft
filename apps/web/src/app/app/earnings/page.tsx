"use client";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, fmtUsd } from "@/lib/use-api";
import { PageHeader, Card, Empty } from "@/components/app/AppShell";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card p-5">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="tnum mt-1.5 text-[26px] font-semibold tracking-[-0.03em] text-ink">{value}</div>
      {sub && <div className="mt-2 text-[12.5px] text-muted">{sub}</div>}
    </div>
  );
}

/** What Weft has earned in fees, and how it splits. Owners only. */
export default function EarningsPage() {
  const auth = useAuth();
  const e = useApi(auth.enabled && auth.authenticated ? () => api.earnings() : null, [auth.authenticated], { pollMs: 60_000 });
  const d = e.data;
  return (
    <>
      <PageHeader title="Earnings" sub="Weft’s fees from every trade, and how they split." />
      <div className="space-y-6 px-5 pb-16 pt-6 lg:px-10">
        {e.error && !d ? (
          <Empty title="Not available" sub="This page is for Weft’s owners." />
        ) : !d ? (
          <div className="h-40 animate-pulse rounded-[12px] bg-paper-2" />
        ) : (
          <>
            <div className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-3">
              <Stat label="Earned so far" value={fmtUsd(d.totalUsd, 2)} sub="Hyperliquid builder fees + Solana swap fees" />
              <Stat label="For $WEFT buybacks" value={fmtUsd(d.buybackUsd, 2)} sub="Half of all fees" />
              <Stat label="Weft’s share" value={fmtUsd(d.weftUsd, 2)} sub="The other half" />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
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
                    <dd className="tnum text-right text-ink-2">{fmtUsd(d.hyperliquid.accountValueUsd, 2)} · {short(d.hyperliquid.builder)}</dd>
                  </dl>
                ) : (
                  <p className="mt-2 text-[13px] text-muted">No builder address set.</p>
                )}
                <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
                  Fees build up on Hyperliquid and are claimed into the builder account with <code className="font-mono">scripts/claim-builder-fees.ts --send</code>.
                </p>
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
                    <dd className="tnum text-right text-ink-2">{short(d.solana.feeWallet)}</dd>
                    <dt className="text-muted">Gas float</dt>
                    <dd className="tnum text-right text-ink-2">{d.solana.sol.toFixed(4)} SOL</dd>
                  </dl>
                ) : (
                  <p className="mt-2 text-[13px] text-muted">No fee wallet set.</p>
                )}
              </Card>
            </div>
            <p className="text-[12.5px] text-faint">
              Weft’s own records of fees paid by live runs: {fmtUsd(d.recordedUsd, 2)}. The venue figures above are what actually arrived.
            </p>
          </>
        )}
      </div>
    </>
  );
}
