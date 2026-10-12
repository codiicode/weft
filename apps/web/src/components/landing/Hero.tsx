import { Demo } from "./Demo";
import { Button } from "../ui/Button";

export function Hero() {
  return (
    <section id="top" className="relative pt-32 sm:pt-40">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <h1 className="display enter max-w-[12ch] text-[clamp(3rem,8.2vw,6.6rem)] leading-[0.98] text-ink">
          Trade the thesis, not the chart.
        </h1>
        <div className="mt-8 max-w-[34rem]">
          <p className="enter text-[18px] leading-[1.55] text-ink-2 text-pretty sm:text-[19px]" style={{ animationDelay: "80ms" }}>
            Write a market view in plain English. Weft turns it into rules you can read, tests them on paper, and trades them from your own
            wallet.
          </p>
          <div className="enter mt-9 flex flex-wrap items-center gap-2" style={{ animationDelay: "140ms" }}>
            <Button href="/app/new" size="lg">
              Start on paper
            </Button>
            <Button href="#how" size="lg" variant="quiet">
              How it works
            </Button>
          </div>
        </div>
      </div>

      <div className="enter mx-auto mt-16 max-w-[1240px] px-3 sm:mt-20 sm:px-5" style={{ animationDelay: "200ms" }}>
        <Demo />
      </div>

      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-2 px-5 pb-20 pt-10 text-[13.5px] text-muted sm:px-8">
        <span>Perps</span>
        <span>Stocks</span>
        <span>Prediction markets</span>
        <span>Solana tokens</span>
        <span className="sm:ml-auto">Executes on Hyperliquid and Jupiter</span>
      </div>
    </section>
  );
}
