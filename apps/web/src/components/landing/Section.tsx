import type { ReactNode } from "react";

/** A landing section: heading on the left, a short lead beside it, content below. */
export function Section({
  id,
  title,
  lead,
  children,
  className = "",
}: {
  id?: string;
  label?: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-16 border-t border-line ${className}`}>
      <div className="mx-auto max-w-[1200px] px-5 py-24 sm:px-8 sm:py-32">
        <div className="grid gap-x-16 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-end">
          <h2 className="display max-w-[16ch] text-[clamp(2.2rem,4.4vw,3.6rem)] leading-[1.04] text-ink text-balance">{title}</h2>
          {lead && <p className="max-w-[34rem] text-[17px] leading-[1.6] text-ink-2 text-pretty lg:pb-2">{lead}</p>}
        </div>
        {children && <div className="mt-14 sm:mt-16">{children}</div>}
      </div>
    </section>
  );
}
