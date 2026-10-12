import { Section } from "./Section";
import { Sparkline } from "../ui/Sparkline";
import { walk } from "@/lib/rng";

const curve = walk(77, 40, 0.35, 0.6);

function Step({ n, title, body, children }: { n: number; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex h-[188px] flex-col justify-center rounded-[12px] border border-line bg-card p-5">{children}</div>
      <div className="mt-6 flex items-baseline gap-3">
        <span className="tnum text-[14px] text-faint">{n}</span>
        <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{title}</h3>
      </div>
      <p className="mt-2 pl-[22px] text-[15px] leading-[1.6] text-ink-2">{body}</p>
    </div>
  );
}

function Rule({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[52px_1fr] gap-2 py-1.5 text-[13.5px]">
      <span className="text-muted">{k}</span>
      <span className="text-ink">{children}</span>
    </div>
  );
}

export function HowItWorks() {
  return (
    <Section
      id="how"
      label="How it works"
      title="You write the idea. Weft does the wiring."
      lead="No indicators, no code. Nothing trades until you approve it, and you can stop it at any time."
    >
      <div className="grid gap-10 md:grid-cols-3 md:gap-6">
        <Step n={1} title="Write it" body="Say what you think will happen, the way you'd text a friend. Any market, any time frame.">
          <p className="display text-[22px] leading-[1.3] text-ink">“Buy $PUMP if it dips to 0.004 and sentiment turns bullish.”</p>
        </Step>
        <Step n={2} title="Check it" body="Weft researches the idea and drafts plain rules: what to watch, when to act, how much to risk. Change anything.">
          <div className="divide-y divide-line">
            <Rule k="Watch">PUMP price, X sentiment</Rule>
            <Rule k="When">
              price ≤ <span className="tnum">0.004</span> and sentiment &gt; <span className="tnum">0.3</span>
            </Rule>
            <Rule k="Do">
              buy <span className="tnum">0.5</span> SOL, stop at <span className="tnum">−20%</span>
            </Rule>
          </div>
        </Step>
        <Step n={3} title="Run it" body="Test on paper against live prices. When you're happy, switch it to live from your own account.">
          <div className="flex items-center justify-between text-[13px]">
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-long" /> Running on paper
            </span>
            <span className="tnum font-medium text-long">+4.2%</span>
          </div>
          <Sparkline data={curve} width={300} height={64} color="var(--long)" strokeWidth={1.6} className="mt-3 w-full" />
          <div className="mt-3 flex items-center justify-between text-[12.5px] text-muted">
            <span>3 trades · 6 days</span>
            <span className="rounded-[6px] border border-line-2 px-2 py-0.5 text-ink-2">Stop</span>
          </div>
        </Step>
      </div>
    </Section>
  );
}
