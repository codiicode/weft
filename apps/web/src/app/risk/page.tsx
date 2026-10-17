import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Part } from "@/components/legal/LegalPage";
import { $T } from "@/config/brand";

export const metadata: Metadata = { title: "Risks · Weft" };

export default function Risk() {
  return (
    <LegalPage
      path="/risk"
      title="The risks"
      updated="17 October 2026"
      intro={
        <p>
          Weft makes trading easier. It doesn’t make it safer. Only trade with money you can afford to lose completely, and read this
          before you start a strategy with real money.
        </p>
      }
    >
      <Part title="You can lose everything you put in">
        <p>
          Every product Weft trades can fall in value fast. A strategy that looked good on paper can lose money for weeks, or all at once.
        </p>
      </Part>

      <Part title="Leverage">
        <p>
          With 20× leverage a 5% move against you wipes out the position, and Hyperliquid closes it before that, at the liquidation
          price. Higher leverage means a smaller move does it. A stop at −20% on the position is a 1% price move at 20×, so it can trigger
          on ordinary noise. Funding also costs or pays you every hour you hold a perp.
        </p>
      </Part>

      <Part title="Tokens, especially new ones">
        <p>
          Most new tokens go to zero. Weft checks every buy for the usual warning signs, but by default a failed check only warns you; it
          blocks the buy only if you ask for that. Checks can’t catch everything: liquidity can vanish, prices can gap past your stop,
          and a token can be impossible to sell.
        </p>
      </Part>

      <Part title="Prediction markets">
        <p>
          An outcome share is worth $1 or nothing when the market settles. Markets can be thin, so selling early may only be possible at a
          much worse price.
        </p>
      </Part>

      <Part title="Rules don’t always do what you meant">
        <p>
          The AI drafts rules from your words and can misread them. Data can arrive late or be wrong. Read every rule before you start,
          start with a small amount, and watch the first trades.
        </p>
      </Part>

      <Part title="Stops are not guarantees">
        <p>
          A stop sells at the next available price, which can be worse than the stop in a fast market. Stops on Hyperliquid sit on the
          venue and keep working if Weft is offline. Stops on Solana tokens are watched by Weft, so they wait while Weft is down.
        </p>
      </Part>

      <Part title="Backtests">
        <p>
          A backtest replays past prices through the same rules. It can’t know what other traders would have done, and it can’t include
          data Weft has no history for, such as the macro and Fear & Greed series. A good backtest is not a promise.
        </p>
      </Part>

      <Part title="Venues, networks and Weft itself">
        <p>
          Hyperliquid, Solana, Jupiter and Privy can have outages, bugs or hacks, and so can Weft. Smart contracts can fail. Your wallet
          is only as safe as the way you sign in, so protect your email and any wallet you link.
        </p>
      </Part>

      <Part title={`The ${$T} token`}>
        <p>
          {$T} is a speculative token. Buybacks don’t guarantee its price, and it can lose all its value. It isn’t a share in Weft.
        </p>
      </Part>

      <Part title="Rules and taxes">
        <p>
          Laws on crypto, derivatives and prediction markets differ by country and change often. Trading can be taxable. You are
          responsible for both. See the <Link href="/terms">terms</Link> for who can use Weft.
        </p>
      </Part>
    </LegalPage>
  );
}
