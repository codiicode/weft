import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Part } from "@/components/legal/LegalPage";
import { brand, $T } from "@/config/brand";

export const metadata: Metadata = { title: "Terms · Weft" };

const hl = (brand.builderFeeBps / 100).toFixed(2);
const sol = +(brand.swapFeeBps / 100).toFixed(2);

export default function Terms() {
  return (
    <LegalPage
      path="/terms"
      title="Terms of use"
      updated="17 October 2026"
      intro={
        <p>
          These terms cover your use of Weft at {brand.domain}. Using the site or the app means you accept them. They’re written in plain
          language on purpose. If something is unclear, ask us on <a href={brand.socials.x}>X</a> before you trade.
        </p>
      }
    >
      <Part title="1. What Weft is">
        <p>
          Weft is software. You describe a trade in your own words, Weft turns it into rules, and, if you start a strategy, it places
          orders for you on third-party venues: Hyperliquid for perps, stocks and prediction markets, and Solana through Jupiter for
          tokens.
        </p>
        <p>
          Weft is not a broker, an exchange, a bank or an investment adviser. Nothing on the site is financial, legal or tax advice. The
          example strategies are examples, not recommendations.
        </p>
      </Part>

      <Part title="2. Your money stays yours">
        <p>
          Weft never holds your funds. Your money sits in your own Hyperliquid account and your own Solana wallet. The wallets Weft
          creates for you are embedded wallets run by Privy; they belong to you and you can export their keys.
        </p>
        <p>
          When you turn on trading you give Weft a limited key. On Hyperliquid it can place and cancel orders but can’t withdraw or
          transfer. On Solana it can only sign swaps that land back in your own wallet. You can stop any strategy at any time, and you
          can move your money out whenever you like.
        </p>
      </Part>

      <Part title="3. Who can use it">
        <ul>
          <li>You must be at least 18 and allowed to enter into these terms where you live.</li>
          <li>
            You’re responsible for making sure trading these products is legal for you. The venues Weft connects to have their own rules
            and restrict some countries. Hyperliquid, for example, isn’t available to people in the United States. Don’t use Weft to get
            around those restrictions.
          </li>
          <li>You can’t use Weft if you’re on a sanctions list or acting for someone who is.</li>
        </ul>
      </Part>

      <Part title="4. You are in charge of your trades">
        <p>
          Every strategy runs the rules you approved, with the amount you chose. You decide when it starts and when it stops. Read the
          rules before you start: the AI that drafts them can misunderstand you, and a rule that reads right can still behave in a way you
          didn’t expect in a fast market.
        </p>
        <p>
          Backtests replay past prices. They don’t include every real-world cost, and past results don’t predict future ones. See{" "}
          <Link href="/risk">the risks</Link> for more.
        </p>
      </Part>

      <Part title="5. Fees">
        <ul>
          <li>Writing and testing strategies is free.</li>
          <li>
            Perp trades on Hyperliquid pay Weft {hl}%, collected by Hyperliquid. Spot and prediction-market buys are free; sells pay the
            same {hl}%. You approve the fee once when you turn on trading.
          </li>
          <li>Swaps on Solana pay Weft a {sol}% fee, taken inside the swap.</li>
          <li>
            Venues and networks charge their own fees on top, such as trading fees, funding, network fees and Hyperliquid’s $1 withdrawal
            fee.
          </li>
          <li>
            Half of Weft’s fees are used to buy back {$T}. Fees and buybacks are public on the <Link href="/revenue">Revenue page</Link>.
          </li>
        </ul>
      </Part>

      <Part title={`6. The ${$T} token`}>
        <p>
          {$T} is not a share in Weft and gives no claim on Weft’s revenue, profits or assets. Buybacks can change or stop. Its price
          can fall to zero. Until we publish the contract address on this site, any token called {$T} is not ours.
        </p>
      </Part>

      <Part title="7. Things outside our control">
        <p>
          Weft depends on other services: Hyperliquid, Solana, Jupiter, Privy, data providers and our hosting. They can go down, change,
          or fail to fill an order. Weft can also have bugs or be offline. When that happens a strategy can miss a trade, trade late, or
          not close a position when its rule says it should. Stops placed on Hyperliquid itself keep working while Weft is down; stops on
          Solana tokens don’t.
        </p>
        <p>
          Weft is provided as it is, without guarantees. As far as the law allows, we aren’t liable for trading losses, missed trades,
          venue failures or indirect losses, and our total liability to you is limited to the fees you paid Weft in the three months
          before the claim.
        </p>
      </Part>

      <Part title="8. Fair use">
        <p>
          Don’t try to break, overload or reverse-engineer the service, use it for market manipulation, or use someone else’s account.
          We can limit or close access for anyone who does, or where the law requires it. Your funds stay in your own wallet either way.
        </p>
      </Part>

      <Part title="9. Shared strategies">
        <p>
          Strategies you share are public without your name attached, and anyone can copy them. Only share what you’re happy for others
          to use. Returns you choose to show on the leaderboard appear in percent only, never amounts or wallets.
        </p>
      </Part>

      <Part title="10. Changes">
        <p>
          We may update these terms as the product changes. The date at the top shows the latest version. If a change matters, we’ll
          say so on the site before it applies. Using Weft after that means you accept the new terms.
        </p>
      </Part>
    </LegalPage>
  );
}
