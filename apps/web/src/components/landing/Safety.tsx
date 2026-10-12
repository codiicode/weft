import { Section } from "./Section";
import { IconCheck } from "../graph/icons";

const can = ["Place and cancel orders", "Set stops and targets", "Swap on Solana, back into your wallet"];
const cannot = ["Withdraw your funds", "Send money to another address", "Trade above the limits you set"];

const guards = [
  ["Paper first", "Every strategy starts on paper with live prices. Going live is a separate, deliberate step."],
  ["Hard limits", "You set the most it can spend per trade and in total. Every position needs a stop."],
  ["One-click stop", "The stop button closes every position and cancels every order, immediately."],
];

export function Safety() {
  return (
    <Section
      id="safety"
      label="Safety"
      className="night"
      title="It can trade. It can’t withdraw."
      lead="Your money stays in your own Hyperliquid account or Solana wallet. Weft gets a trading-only key that you can revoke at any time."
    >
      <div className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2">
        <div className="bg-paper p-6 sm:p-8">
          <p className="text-[13px] text-muted">The agent can</p>
          <ul className="mt-4 space-y-3">
            {can.map((t) => (
              <li key={t} className="flex items-center gap-3 text-[15.5px] text-ink">
                <IconCheck size={15} strokeWidth={2.2} className="shrink-0 text-long" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-paper p-6 sm:p-8">
          <p className="text-[13px] text-muted">The agent can’t</p>
          <ul className="mt-4 space-y-3">
            {cannot.map((t) => (
              <li key={t} className="flex items-center gap-3 text-[15.5px] text-ink-2">
                <span className="relative h-[15px] w-[15px] shrink-0 text-short" aria-hidden>
                  <span className="absolute left-1/2 top-1/2 h-[2px] w-[13px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded bg-current" />
                  <span className="absolute left-1/2 top-1/2 h-[2px] w-[13px] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded bg-current" />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
        {guards.map(([t, b]) => (
          <div key={t}>
            <h3 className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{t}</h3>
            <p className="mt-2 text-[15px] leading-[1.6] text-ink-2">{b}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
