"use client";
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { socialPosts } from "@/data/mock";
import { useInterval } from "@/lib/hooks";
import { IconSocial } from "@/components/graph/icons";
import { WidgetCard, type WidgetProps } from "./WidgetCard";
import { EASE } from "./WidgetCard";

/* Feed settings. */
const SOCIAL_VISIBLE = 3;
const SOCIAL_EVERY_MS = 3400;
const SOCIAL_META = "X · 412 accounts";

type Post = (typeof socialPosts)[number];
type Item = { uid: number; post: Post };

function highlight(text: string, match: string): ReactNode {
  const i = text.toLowerCase().indexOf(match.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className="highlight">{text.slice(i, i + match.length)}</span>
      {text.slice(i + match.length)}
    </>
  );
}

const initials = (name: string) =>
  name
    .replace(/[^A-Za-z ]/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

function Body({ live }: { live: boolean }) {
  const [state, setState] = useState(() => ({
    items: socialPosts.slice(0, SOCIAL_VISIBLE).map((post, uid) => ({ uid, post })) as Item[],
    cursor: SOCIAL_VISIBLE,
    uid: SOCIAL_VISIBLE,
  }));
  useInterval(
    () =>
      setState((s) => {
        const post = socialPosts[s.cursor % socialPosts.length];
        return {
          items: [{ uid: s.uid, post: { ...post, ago: "now" } }, ...s.items].slice(0, SOCIAL_VISIBLE),
          cursor: s.cursor + 1,
          uid: s.uid + 1,
        };
      }),
    SOCIAL_EVERY_MS,
    live
  );

  return (
    <div className="relative -mx-1 min-h-[318px] flex-1 overflow-hidden px-1 [mask-image:linear-gradient(to_bottom,black_78%,transparent)]">
      <ul className="space-y-2.5">
        <AnimatePresence initial={false} mode="popLayout">
          {state.items.map((it, i) => (
            <motion.li
              key={it.uid}
              layout
              initial={{ opacity: 0, y: -18, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.3 } }}
              transition={{ duration: 0.6, ease: EASE }}
              className={`rounded-[12px] border p-3 transition-colors duration-700 ${
                i === 0 ? "border-line-2 bg-card" : "border-line bg-card-2"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border border-line bg-[var(--paper-2)] font-mono text-[9.5px] font-semibold text-ink-2">
                  {initials(it.post.name)}
                </span>
                <div className="min-w-0 leading-tight">
                  <div className="truncate text-[12.5px] font-semibold tracking-[-0.01em] text-ink">{it.post.name}</div>
                  <div className="truncate font-mono text-[10px] text-faint">
                    {it.post.handle} · {it.post.ago}
                  </div>
                </div>
              </div>
              <p className="mt-2 text-[13px] leading-[1.45] text-ink-2">{highlight(it.post.text, it.post.match)}</p>
              <div className="mt-2.5 flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-2">
                  <span className="h-[5px] w-[5px] rounded-full bg-[var(--signal)]" />
                  Signal matched
                  <span className="tnum text-ink">{it.post.score.toFixed(2)}</span>
                </span>
                <span className="truncate font-mono text-[9.5px] text-faint">“{it.post.match}”</span>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export function SocialFeedWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconSocial} label="Social" meta={SOCIAL_META} className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
