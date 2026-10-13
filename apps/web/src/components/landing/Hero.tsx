import { Loom } from "./Loom";
import { Button } from "../ui/Button";

const LINES = ["Trade the thesis,", "not the chart."];

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-28 sm:pt-36">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] lg:items-end">
          <h1 className="display text-[clamp(3rem,8vw,6.6rem)] leading-[0.98] text-ink">
            {LINES.map((l, i) => (
              <span key={l} className="rise-line">
                <span style={{ animationDelay: `${i * 110}ms` }}>{l}</span>
              </span>
            ))}
          </h1>
          <div className="lg:pb-3">
            <p className="enter text-[17px] leading-[1.55] text-ink-2 text-pretty sm:text-[18px]" style={{ animationDelay: "260ms" }}>
              Say what you think will happen. Weft turns it into rules you can read, tests them on paper, and trades them from your own wallet.
            </p>
            <div className="enter mt-7 flex flex-wrap items-center gap-2" style={{ animationDelay: "340ms" }}>
              <Button href="/app/new" size="lg">
                Start on paper
              </Button>
              <Button href="#work" size="lg" variant="quiet">
                See it work
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* full-bleed loom */}
      <div className="enter mt-8 sm:mt-10" style={{ animationDelay: "420ms" }}>
        <Loom />
      </div>

      <div className="mx-auto mt-8 flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-2 border-t border-line px-5 py-6 text-[13.5px] text-muted sm:px-8">
        <span>Perps</span>
        <span>Stocks</span>
        <span>Prediction markets</span>
        <span>Solana tokens</span>
        <span className="sm:ml-auto">Executes on Hyperliquid and Jupiter</span>
      </div>
    </section>
  );
}
