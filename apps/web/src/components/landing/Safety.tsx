import { Section } from "./Section";
import { IconCheck } from "../graph/icons";
import { Reveal } from "../ui/Reveal";
import { SafetyDiagram } from "./SafetyDiagram";

const can = ["Place and cancel orders", "Set stops and targets", "Swap tokens inside your own wallet"];
const cannot = ["Withdraw your money", "Send it to another address", "Trade a strategy you haven’t started"];

const guards = [
  ["Test it first", "See how a strategy would have done on recent market data before you put money in."],
  ["Your amount, your stop", "A strategy trades with the amount you give it. Add a stop or a target in plain words and it’s placed with the order."],
  ["Stop it any time", "Hold the stop button and Weft closes everything the strategy holds, right away."],
];

export function Safety() {
  return (
    <Section
      id="safety"
      label="Safety"
      className="night"
      title="It can trade. It can’t withdraw."
      lead="Your money stays in your own account, on Hyperliquid and on Solana. Weft gets a key that can trade for you, and nothing else."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-stretch">
      <SafetyDiagram />
      <div className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line">
        <div className="bg-paper p-6 sm:p-7">
          <p className="text-[13px] text-muted">The agent can</p>
          <ul className="mt-4 space-y-3">
            {can.map((t, i) => (
              <li key={t}>
                <Reveal delay={300 + i * 140} className="flex items-center gap-3 text-[15.5px] text-ink">
                  <IconCheck size={15} strokeWidth={2.2} className="shrink-0 text-long" /> {t}
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-paper p-6 sm:p-7">
          <p className="text-[13px] text-muted">The agent can’t</p>
          <ul className="mt-4 space-y-3">
            {cannot.map((t, i) => (
              <li key={t}>
                <Reveal delay={720 + i * 140} className="flex items-center gap-3 text-[15.5px] text-ink-2">
                <span className="relative h-[15px] w-[15px] shrink-0 text-short" aria-hidden>
                  <span className="absolute left-1/2 top-1/2 h-[2px] w-[13px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded bg-current" />
                  <span className="absolute left-1/2 top-1/2 h-[2px] w-[13px] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded bg-current" />
                </span>
                {t}
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </div>
      </div>

      <ul className="mt-14 flex flex-wrap gap-x-10 gap-y-4 border-t border-line pt-8 text-[15px]">
        {guards.map(([t, b]) => (
          <li key={t} className="max-w-[22rem]">
            <span className="font-medium text-ink">{t}.</span> <span className="text-ink-2">{b}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
