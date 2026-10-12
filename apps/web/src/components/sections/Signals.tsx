import { Reveal, SectionHeading } from "@/components/ui/Reveal";
import { PredictionMarketWidget } from "@/components/widgets/PredictionMarket";
import { PerpChartWidget } from "@/components/widgets/PerpChart";
import { Hip3MarketsWidget } from "@/components/widgets/Hip3Markets";
import { SentimentGaugeWidget } from "@/components/widgets/SentimentGauge";
import { SocialFeedWidget } from "@/components/widgets/SocialFeed";
import { FundingHeatmapWidget } from "@/components/widgets/FundingHeatmap";
import { NewsWireWidget } from "@/components/widgets/NewsWire";
import { PortfolioWidget } from "@/components/widgets/Portfolio";
import { ForecastPlumeWidget } from "@/components/widgets/ForecastPlume";
import { TokenOnchainWidget } from "@/components/widgets/TokenOnchain";

/* Section-level mock stats. */
const SIGNAL_STATS = [
  { k: "Signal families", v: "10" },
  { k: "Sources", v: "40+" },
  { k: "Median latency", v: "380ms" },
];

export function Signals() {
  return (
    <section id="signals" className="relative py-24 md:py-36">
      <div
        aria-hidden
        className="dot-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_70%_50%_at_50%_45%,black,transparent)]"
      />
      <div className="relative mx-auto max-w-[1240px] px-5">
        <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="Signals"
            title={
              <>
                Everything the market is <span className="serif-em">saying,</span> wired in.
              </>
            }
            sub="Weft listens around the clock: weather forecasts, prediction odds, perps, funding, on-chain token data, news and social sentiment. Every feed becomes a signal your strategy can act on the moment it moves."
          />
          <Reveal delay={0.15} className="shrink-0">
            <dl className="grid grid-cols-3 divide-x divide-line rounded-[14px] border border-line bg-card/70 shadow-card backdrop-blur">
              {SIGNAL_STATS.map((s) => (
                <div key={s.k} className="px-4 py-3 sm:px-5">
                  <dt className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">{s.k}</dt>
                  <dd className="tnum mt-1 font-mono text-[20px] font-medium tracking-[-0.03em] text-ink">{s.v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5 lg:grid-cols-12">
          <PredictionMarketWidget className="md:col-span-2 lg:col-span-7" index={0} />
          <PerpChartWidget className="lg:col-span-5" index={1} />
          <Hip3MarketsWidget className="lg:col-span-4" index={0} />
          <SocialFeedWidget className="lg:col-span-4" index={1} />
          <SentimentGaugeWidget className="lg:col-span-4" index={2} />
          <TokenOnchainWidget className="md:col-span-2 lg:col-span-12" index={0} />
          <FundingHeatmapWidget className="md:col-span-2 lg:col-span-7" index={0} />
          <NewsWireWidget className="lg:col-span-5" index={1} />
          <PortfolioWidget className="lg:col-span-5" index={0} />
          <ForecastPlumeWidget className="md:col-span-2 lg:col-span-7" index={1} />
        </div>
      </div>
    </section>
  );
}
