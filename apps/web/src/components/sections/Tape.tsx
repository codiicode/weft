import { tape } from "@/data/mock";

function fmt(px: number, odds?: boolean) {
  if (odds) return `${Math.round(px * 100)}¢`;
  if (px >= 1000) return px.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (px >= 10) return px.toFixed(2);
  return px.toFixed(px < 1 ? 4 : 3);
}

function Row() {
  return (
    <div className="flex shrink-0 items-center">
      {tape.map((t) => (
        <span key={t.sym} className="flex items-center gap-2.5 px-6 font-mono text-[12px]">
          <span className="text-ink-2">{t.sym}</span>
          <span className="tnum text-ink">{fmt(t.px, t.odds)}</span>
          <span className="tnum" style={{ color: t.ch >= 0 ? "var(--long)" : "var(--short)" }}>
            {t.ch >= 0 ? "▲" : "▼"} {Math.abs(t.ch).toFixed(2)}%
          </span>
          <span className="ml-4 h-1 w-1 rounded-full bg-line-2" />
        </span>
      ))}
    </div>
  );
}

export function Tape() {
  return (
    <section aria-label="Markets the agent can trade (demo prices)" className="relative border-y border-line bg-card/50">
      <div className="mx-auto flex max-w-[1240px] items-stretch">
        <div className="relative z-10 hidden shrink-0 items-center gap-2 border-r border-line bg-paper py-3.5 pl-5 pr-6 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted md:flex">
          Executes on <span className="text-ink">Hyperliquid</span> + <span className="text-ink">Jupiter</span>
        </div>
        <div className="marquee-paused relative flex-1 overflow-hidden py-3.5 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
          <div className="marquee flex w-max" style={{ ["--marquee-dur" as string]: "70s" }}>
            <Row />
            <Row />
          </div>
        </div>
      </div>
    </section>
  );
}
