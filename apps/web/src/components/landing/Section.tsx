import type { ReactNode } from "react";

/**
 * A landing section. Layouts vary so the page doesn't read as one template:
 *  - split: heading left, lead beside it, content below
 *  - stack: heading, lead under it, content below
 *  - aside: heading and lead in a sticky left column, content on the right
 */
export function Section({
  id,
  title,
  lead,
  children,
  className = "",
  layout = "split",
}: {
  id?: string;
  label?: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
  layout?: "split" | "stack" | "aside";
}) {
  const h2 = <h2 className="display max-w-[16ch] text-[clamp(2.2rem,4.4vw,3.6rem)] leading-[1.04] text-ink text-balance">{title}</h2>;
  const p = (extra = "") => (lead ? <p className={`max-w-[34rem] text-[17px] leading-[1.6] text-ink-2 text-pretty ${extra}`}>{lead}</p> : null);
  return (
    <section id={id} className={`scroll-mt-16 border-t border-line ${className}`}>
      <div className="mx-auto max-w-[1200px] px-5 py-24 sm:px-8 sm:py-32">
        {layout === "aside" ? (
          <div className="grid gap-12 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-20">
            <div className="lg:sticky lg:top-28 lg:self-start">
              {h2}
              {p("mt-5")}
            </div>
            <div>{children}</div>
          </div>
        ) : (
          <>
            {layout === "split" ? (
              <div className="grid gap-x-16 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-end">
                {h2}
                {p("lg:pb-2")}
              </div>
            ) : (
              <div>
                {h2}
                {p("mt-5")}
              </div>
            )}
            {children && <div className="mt-14 sm:mt-16">{children}</div>}
          </>
        )}
      </div>
    </section>
  );
}
