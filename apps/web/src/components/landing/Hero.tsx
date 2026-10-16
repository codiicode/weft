import { Loom } from "./Loom";
import { Button } from "../ui/Button";

const LINES = ["Trade the thesis,", "not the chart."];

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-28 sm:pt-32">
      <div className="relative z-10 mx-auto max-w-[1200px] px-5 sm:px-8">
        <h1 className="display text-[clamp(3.5rem,9.4vw,8.5rem)] leading-[0.94] tracking-[-0.032em] text-ink">
          {LINES.map((l, i) => (
            <span key={l} className="rise-line">
              <span style={{ animationDelay: `${i * 110}ms` }}>{l}</span>
            </span>
          ))}
        </h1>
        <div className="mt-8 flex flex-col gap-6 sm:mt-10 lg:flex-row lg:items-center lg:justify-between">
          <p className="enter max-w-[34rem] text-[17px] leading-[1.55] text-ink-2 text-pretty sm:text-[19px]" style={{ animationDelay: "260ms" }}>
            Say what you think will happen. Weft turns it into rules you can read, tests them on real history, and trades them from your own wallet.
          </p>
          <div className="enter flex shrink-0 flex-wrap items-center gap-2" style={{ animationDelay: "340ms" }}>
            <Button href="/new" size="lg">
              Start trading
            </Button>
            <Button href="#work" size="lg" variant="quiet">
              See it work
            </Button>
          </div>
        </div>
      </div>

      {/* full-bleed loom, tucked up under the headline */}
      <div className="enter relative -mt-2 sm:-mt-4" style={{ animationDelay: "420ms" }}>
        <Loom />
      </div>
    </section>
  );
}
