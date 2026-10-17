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
        <Reveal delay={200}>
          <dl className="mt-14 grid gap-x-10 gap-y-6 border-t border-line pt-8 text-[15px] sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Fee on Hyperliquid", `${(brand.builderFeeBps / 100).toFixed(2)}% per trade`],
              ["Fee on Solana swaps", `${+(brand.swapFeeBps / 100).toFixed(2)}% per swap`],
              ["Where fees go", `${Math.round(brand.buybackShare * 100) === 50 ? "Half" : `${Math.round(brand.buybackShare * 100)}%`} buys ${$T} on the open market`],
              [`Hold ${$T}`, `Pay ${brand.holderDiscount === 0.5 ? "half" : `${Math.round((1 - brand.holderDiscount) * 100)}% of`} the fee`],
              ["Launch", `${brand.chain}, through ${brand.launchpad}`],
              [`Trading ${$T}`, `${brand.tokenFee.totalBps / 100}% fee: ${brand.tokenFee.protocolBps / 100}% to Weft, ${brand.tokenFee.buybackBps / 100}% buys back ${$T}, ${brand.tokenFee.meteoraBps / 100}% to Meteora`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[13px] text-muted">{k}</dt>
                <dd className="mt-1 text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-[13.5px] text-muted">
            No subscription. Every fee and every buyback is on the{" "}
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
