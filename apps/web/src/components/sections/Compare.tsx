import { brand } from "@/config/brand";
import { comparison } from "@/data/mock";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { IconCheck, IconX } from "../graph/icons";
import { LogoMark } from "../ui/Logo";

export function Compare() {
  return (
    <section id="compare" className="relative py-24 md:py-36">
      <div className="mx-auto max-w-[1240px] px-5">
        <SectionHeading
          eyebrow="Open vs. closed"
          align="center"
          title={
            <>
              Same ambition. <span className="serif-em">Opposite</span> architecture.
            </>
          }
          sub={`Closed AI trading apps ask you to trust a black box with your money. ${brand.name} shows you every wire, and never holds your funds.`}
        />
        <Reveal className="mt-14">
          <div className="relative overflow-hidden rounded-[24px] border border-line bg-card shadow-card">
            {/* highlighted column backdrop */}
            <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[36%] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--volt)_16%,transparent),transparent_60%)] md:block" />
            <div className="relative grid grid-cols-[minmax(0,1fr)] border-b border-line md:grid-cols-[28%_36%_36%]">
              <div className="hidden px-6 py-5 md:block" />
              <div className="hidden items-center gap-2 px-6 py-5 text-[14px] text-muted md:flex">
                <span className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-paper-2 font-mono text-[11px]">?</span>
                Closed AI trading apps
              </div>
              <div className="flex items-center gap-2 px-6 py-5 text-[15px] font-semibold">
                <LogoMark size={26} /> {brand.name}
                <span className="ml-2 rounded-full bg-ink px-2 py-0.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-paper">Open</span>
              </div>
            </div>
            {comparison.map((row, i) => (
              <div key={row.label} className={`relative grid grid-cols-1 gap-2 px-6 py-5 md:grid-cols-[28%_36%_36%] md:gap-0 md:px-0 md:py-0 ${i < comparison.length - 1 ? "border-b border-line" : ""}`}>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted md:px-6 md:py-5">{row.label}</div>
                <div className="flex items-start gap-2.5 text-[14.5px] text-ink-2 md:px-6 md:py-5">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-paper-2 text-faint">
                    <IconX size={10} strokeWidth={2.2} />
                  </span>
                  {row.them}
                </div>
                <div className="flex items-start gap-2.5 text-[14.5px] font-medium text-ink md:px-6 md:py-5">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-volt text-[#0b0c0f]">
                    <IconCheck size={11} strokeWidth={2.4} />
                  </span>
                  {row.us}
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
