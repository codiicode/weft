import type { Metadata } from "next";
import { LegalPage, Part } from "@/components/legal/LegalPage";
import { brand } from "@/config/brand";

export const metadata: Metadata = { title: "Privacy · Weft" };

export default function Privacy() {
  return (
    <LegalPage
      path="/privacy"
      title="Privacy"
      updated="17 October 2026"
      intro={
        <p>
          Weft collects what it needs to run your strategies and nothing more. There are no ads, no tracking scripts and no analytics on
          the site. This page lists exactly what we keep and who else sees it.
        </p>
      }
    >
      <Part title="What we keep">
        <ul>
          <li>
            <strong className="font-medium text-ink">Your account.</strong> An account id from Privy, your email address if you sign in
            with email or Google, and when you last used Weft.
          </li>
          <li>
            <strong className="font-medium text-ink">Your wallet addresses.</strong> The Hyperliquid and Solana addresses linked to your
            account, so Weft can show balances and place your trades. Addresses are public on-chain anyway.
          </li>
          <li>
            <strong className="font-medium text-ink">Your strategies and runs.</strong> The rules you write, the amounts you start them with,
            and every check, order, fill and position, so you can see what happened and why.
          </li>
          <li>
            <strong className="font-medium text-ink">Telegram, if you connect it.</strong> Your Telegram chat id and username, to send your
            alerts.
          </li>
          <li>
            <strong className="font-medium text-ink">Drafts without an account.</strong> A one-way hash of your IP address, so we can
            count the free drafts and tests per day. The address itself isn’t stored.
          </li>
          <li>
            <strong className="font-medium text-ink">Server logs.</strong> Technical logs of requests and errors, kept for a short time to
            keep the service running.
          </li>
        </ul>
        <p>
          We never see your private keys. Wallets created in Weft are held by Privy, and the keys Weft uses to trade for you can’t move
          money out of your wallet.
        </p>
      </Part>

      <Part title="What’s public">
        <ul>
          <li>Strategies you choose to share, without your name or email.</li>
          <li>Returns you choose to show on the leaderboard, in percent only.</li>
          <li>Your trades on Hyperliquid and Solana, which are public on those networks like any other on-chain activity.</li>
        </ul>
      </Part>

      <Part title="Who else sees data">
        <ul>
          <li>
            <strong className="font-medium text-ink">Privy</strong> runs sign-in and the embedded wallets.
          </li>
          <li>
            <strong className="font-medium text-ink">Anthropic</strong> receives the text of a trade idea when you ask Weft to draft or
            change a strategy. Nothing else about you is sent.
          </li>
          <li>
            <strong className="font-medium text-ink">Hyperliquid, Jupiter and Solana</strong> receive your orders and transactions, as
            they would from any app.
          </li>
          <li>
            <strong className="font-medium text-ink">Railway and Vercel</strong> host Weft’s server and website.
          </li>
          <li>
            <strong className="font-medium text-ink">Telegram</strong> delivers your alerts, if you connect it.
          </li>
        </ul>
        <p>We don’t sell data and don’t share it with anyone else, unless the law requires it.</p>
      </Part>

      <Part title="In your browser">
        <p>
          The site stores a few settings in your browser, such as light or dark mode and chart preferences. Privy stores what it needs to
          keep you signed in. There are no advertising or tracking cookies.
        </p>
      </Part>

      <Part title="Your choices">
        <p>
          You can stop sharing a strategy or a return at any time, disconnect Telegram in Settings, and export your wallet keys. To see or
          delete the data tied to your account, message us on <a href={brand.socials.x}>X</a>. Deleting your account doesn’t touch your
          wallets or the money in them; that stays yours.
        </p>
      </Part>
    </LegalPage>
  );
}
