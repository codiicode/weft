import { Section } from "./Section";
import { brand, $T } from "@/config/brand";

const steps = [
  ["You trade", "A strategy places an order on Hyperliquid or swaps on Solana."],
  ["A small fee", `${(brand.builderFeeBps / 100).toFixed(2)}% on Hyperliquid, ${(brand.swapFeeBps / 100).toFixed(1)}% on Solana swaps.`],
  ["Buyback", `The fees buy ${$T} on the open market. Every purchase is on-chain.`],
];

export function Token() {
  return (
    <Section
      id="token"
      label="Token"
      title={`Trading fees buy back ${$T}.`}
      lead={`${$T} launches on ${brand.chain} through ${brand.launchpad}. There are no subscriptions. Weft earns only when strategies trade, and that revenue goes to buybacks.`}
    >
      <ol className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line md:grid-cols-3">
        {steps.map(([t, b], i) => (
          <li key={t} className="bg-card p-6 sm:p-8">
            <span className="tnum text-[13px] text-faint">{i + 1}</span>
            <h3 className="mt-6 text-[18px] font-semibold tracking-[-0.02em] text-ink">{t}</h3>
            <p className="mt-2 text-[15px] leading-[1.6] text-ink-2">{b}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-[13.5px] text-muted">
        Contract address will be published here at launch. Anything else claiming to be {$T} is not.
      </p>
    </Section>
  );
}
