import { Reveal } from "../ui/Reveal";
import { brand, $T } from "@/config/brand";

/** An inline length of thread with a fee travelling along it. */
function Thread({ delay = 0 }: { delay?: number }) {
  return (
    <svg viewBox="0 0 96 20" className="mx-[0.18em] inline-block h-[0.42em] w-[1.6em] align-middle" aria-hidden>
      <line x1="2" x2="94" y1="10" y2="10" style={{ stroke: "var(--line-2)" }} strokeWidth="3" strokeLinecap="round" />
      <circle cx="10" cy="10" r="7" className="token-bead" style={{ fill: "var(--long)", animationDelay: `${delay}s` }} />
    </svg>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r = brand.rewards;

/** Where each day's buyback goes, as one bar split three ways. */
const SPLIT = [
  { share: r.traderShare, color: "var(--long)", title: "Back to traders", body: `Shared out every day. Your share is the fees you paid that day, so trading only for the reward never pays.` },
  { share: r.creatorShare, color: "var(--signal)", title: "To creators", body: "Publish a strategy. When other people run it, you earn from the fees their runs pay." },
  { share: r.burnShare, color: "var(--trigger)", title: "Burned", body: `Burned the moment it’s bought. There is no team allocation and nothing new is ever minted, so the supply only shrinks.` },
];

const t = brand.tiers;
const k = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}K`);
/** The two tiers, side by side. */
const TIERS = [
  { name: "Holder", min: t.holder.min, discount: t.holder.discount, boost: r.holderBoost },
  { name: "Whale", min: t.whale.min, discount: t.whale.discount, boost: r.whaleBoost },
];

const HOLD = [
  ["Lower fees", `${pct(t.holder.discount)} off every trade from ${k(t.holder.min)} ${$T}, ${pct(t.whale.discount)} off from ${k(t.whale.min)}.`],
  ["Bigger rewards", `${r.holderBoost}× your share of the daily rewards as a Holder, ${r.whaleBoost}× as a Whale.`],
  [`${brand.aiDrafts.holders} AI drafts a day`, `Instead of ${brand.aiDrafts.everyone}. Weft writes, rewrites and tests more strategies for you.`],
  ["Claim daily", "Each day’s rewards are ready right after midnight UTC. One click sends them to your wallet."],
];

export function Token() {
  return (
    <section id="token" className="scroll-mt-16 border-t border-line">
      <div className="mx-auto max-w-[1200px] px-5 py-24 sm:px-8 sm:py-32">
        <p className="text-[14px] text-muted">The {$T} token</p>
        <Reveal mask className="mt-5">
          <h2 className="display text-[clamp(2.2rem,5.2vw,4.6rem)] leading-[1.1] text-ink">
            You trade
            <Thread />
            a small fee
            <Thread delay={1.1} />
            <br className="hidden lg:block" />
            {$T} gets bought back.
          </h2>
        </Reveal>
        <Reveal delay={120}>
          <p className="mt-6 max-w-[640px] text-[clamp(1.05rem,1.6vw,1.25rem)] leading-relaxed text-ink-2">
            Weft buys {$T} on the open market in small amounts about every ten minutes, around the clock: with{" "}
            {pct(brand.buybackShare) === "50%" ? "half" : pct(brand.buybackShare)} of every fee it earns, and {brand.tokenFee.buybackBps / 100}% of every {$T} trade. Then it goes
            back to the people who use Weft: the traders, the people who write the strategies, and the rest is burned.
          </p>
        </Reveal>

        <Reveal delay={200}>
          <div className="mt-14">
            <div className="flex items-baseline justify-between text-[13px] text-muted">
              <span>Every buyback</span>
              <span className="tnum">100%</span>
            </div>
            <div className="mt-3 flex h-3 gap-[3px] overflow-hidden rounded-full">
              {SPLIT.map((s) => (
                <div key={s.title} style={{ width: pct(s.share), background: s.color }} />
              ))}
            </div>
            <div className="mt-8 grid gap-8 sm:grid-cols-3">
              {SPLIT.map((s) => (
                <div key={s.title} className="border-t-2 pt-4" style={{ borderColor: s.color }}>
                  <div className="tnum text-[clamp(2rem,3.4vw,2.8rem)] font-semibold leading-none tracking-[-0.04em] text-ink">{pct(s.share)}</div>
                  <div className="mt-3 text-[16px] font-semibold tracking-[-0.015em] text-ink">{s.title}</div>
                  <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">{s.body}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 text-[14.5px] text-ink-2">
              In practice: about a quarter of the fees you pay comes back to you in {$T}, more if you hold it.
            </p>
          </div>
        </Reveal>

        <Reveal delay={260}>
          <div className="mt-20">
            <h3 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Why hold {$T}</h3>
            <div className="mt-6 grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2">
              {TIERS.map((x) => (
                <div key={x.name} className="bg-paper p-6">
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="text-[17px] font-semibold tracking-[-0.02em] text-ink">{x.name}</div>
                    <div className="tnum text-[13px] text-muted">from {x.min.toLocaleString("en-US")} {$T}</div>
                  </div>
                  <div className="tnum mt-4 text-[clamp(2rem,3.4vw,2.6rem)] font-semibold leading-none tracking-[-0.04em] text-ink">{pct(x.discount)} off</div>
                  <p className="mt-2 text-[14px] text-muted">every trade, plus {x.boost}× rewards and {brand.aiDrafts.holders} AI drafts a day</p>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
              {HOLD.map(([k, v]) => (
                <div key={k} className="bg-paper p-6">
                  <div className="text-[17px] font-semibold tracking-[-0.02em] text-ink">{k}</div>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{v}</p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delay={300}>
          <dl className="mt-16 grid gap-x-10 gap-y-6 border-t border-line pt-8 text-[15px] sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Fee on Hyperliquid", `${(brand.builderFeeBps / 100).toFixed(2)}% on perps, ${+(brand.hlSpotFeeBps / 100).toFixed(2)}% on spot sales`],
              ["Fee on Solana swaps", `${+(brand.swapFeeBps / 100).toFixed(2)}% per swap`],
              ["Launch", `${brand.chain}, through ${brand.launchpad}. All of the supply on the curve, no team tokens. Weft’s own buy at launch is burned`],
              [`Trading ${$T}`, `${brand.tokenFee.totalBps / 100}% fee: ${brand.tokenFee.protocolBps / 100}% to Weft, ${brand.tokenFee.buybackBps / 100}% buys back ${$T}, ${brand.tokenFee.meteoraBps / 100}% to Meteora`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[13px] text-muted">{k}</dt>
                <dd className="mt-1 text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-[13.5px] text-muted">
            Rewards start the day {$T} launches. Every fee, buyback, burn and reward is on the{" "}
            <a href="/revenue" className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
              Revenue page
            </a>
            . We’ll post the contract address here at launch. Any token calling itself {$T} before then is fake.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
