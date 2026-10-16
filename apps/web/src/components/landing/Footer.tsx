import { Logo } from "../ui/Logo";
import { brand } from "@/config/brand";

const cols: [string, [string, string][]][] = [
  ["Product", [["Open app", "/home"], ["Strategies", "/strategies"], ["Markets", "/markets"], ["Live trading", "/accounts"]]],
  ["Learn", [["How it works", "#work"], ["Safety", "#safety"], ["Token", "#token"], ["Questions", "#faq"]]],
  ["Follow", [["X", brand.socials.x], ["Telegram", brand.socials.telegram], ["GitHub", brand.socials.github]]],
];

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-[1200px] px-5 pb-12 pt-16 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-[1fr_auto_auto_auto] sm:gap-16">
          <div>
            <Logo />
            <p className="mt-3 max-w-[18rem] text-[14px] leading-[1.6] text-muted">{brand.tagline} Open-source strategies, non-custodial execution.</p>
          </div>
          {cols.map(([h, links]) => (
            <div key={h}>
              <p className="text-[13px] text-muted">{h}</p>
              <ul className="mt-3 space-y-2">
                {links.map(([l, href]) => (
                  <li key={l}>
                    <a href={href} className="link-draw text-[14px] text-ink-2 transition-colors hover:text-ink">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-16 max-w-[52rem] text-[12.5px] leading-[1.6] text-faint">
          Not financial advice. Trading perpetual futures, leveraged products, prediction markets and memecoins carries a high risk of loss.
          Examples on this page are illustrative. Weft is not affiliated with Hyperliquid, Jupiter or any venue named here.
        </p>
        <p className="mt-4 text-[12.5px] text-faint">© {new Date().getFullYear()} {brand.name}</p>
      </div>
    </footer>
  );
}
