import type { ReactNode } from "react";

/** Editorial section: a quiet label column on the left, content on the right. */
export function Section({
  id,
  label,
  title,
  lead,
  children,
  className = "",
}: {
  id?: string;
  label: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-16 border-t border-line ${className}`}>
      <div className="mx-auto max-w-[1200px] px-5 py-24 sm:px-8 sm:py-32">
        <div className="grid gap-x-12 gap-y-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <p className="pt-2 text-[14px] text-muted">{label}</p>
          <div>
            <h2 className="display max-w-[18ch] text-[clamp(2.2rem,4.4vw,3.6rem)] leading-[1.04] text-ink text-balance">{title}</h2>
            {lead && <p className="mt-5 max-w-[36rem] text-[17px] leading-[1.6] text-ink-2 text-pretty">{lead}</p>}
          </div>
        </div>
        {children && <div className="mt-14 sm:mt-16 lg:pl-[268px]">{children}</div>}
      </div>
    </section>
  );
}
