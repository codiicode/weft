import { Reveal } from "../ui/Reveal";

/** A breath between the hero and the walkthrough: two lines, centred, nothing else. */
export function Statement() {
  return (
    <section className="border-t border-line" aria-label="What Weft does">
      <div className="mx-auto max-w-[1200px] px-5 py-32 text-center sm:px-8 sm:py-44">
        <Reveal mask>
          <p className="display text-[clamp(2.2rem,5.4vw,4.6rem)] leading-[1.06] text-ink">It watches the market day and night.</p>
        </Reveal>
        <Reveal mask delay={180}>
          <p className="display text-[clamp(2.2rem,5.4vw,4.6rem)] leading-[1.06] text-muted">You just have to be right.</p>
        </Reveal>
      </div>
    </section>
  );
}
