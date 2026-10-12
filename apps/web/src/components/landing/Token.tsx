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
      title={`Fees buy back ${$T}`}
      lead={`${$T} launches on ${brand.chain} through ${brand.launchpad}. There are no subscriptions. Weft earns only when strategies trade, and that revenue goes to buybacks.`}
    >
      <ol className="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-0">
        {steps.map(([t, b], i) => (
          <li key={t} className="flex flex-1 flex-col md:flex-row md:items-center">
            <div className="flex-1 border-l-2 py-1 pl-5 md:border-l-0 md:border-t-2 md:pl-0 md:pt-6" style={{ borderColor: i === 2 ? "var(--ink)" : "var(--line-2)" }}>
              <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{t}</h3>
              <p className="mt-2 max-w-[18rem] text-[15px] leading-[1.6] text-ink-2">{b}</p>
            </div>
            {i < steps.length - 1 && (
              <span className="hidden px-6 text-[20px] text-faint md:block" aria-hidden>
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-12 text-[13.5px] text-muted">
        Contract address will be published here at launch. Anything else claiming to be {$T} is not.
      </p>
    </Section>
  );
}
