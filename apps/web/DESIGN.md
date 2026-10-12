# Weft — design direction

**Name.** Weft ($WEFT). The weft is the thread woven *across* the warp to make cloth.
Weft weaves signals through triggers into actions: a thesis becomes fabric you can read.
Shortlist: **Weft** ($WEFT), **Kairos** ($KAIRO, "the opportune moment"), **Sibyl** ($SIBYL, the oracle).
Swap in `src/config/brand.ts`.

**Mood.** Instrument-grade paper. A finely printed financial broadsheet crossed with
a precision instrument. Warm paper, true ink, one electric highlighter. "Night loom"
sections (safety, token) drop into deep ink for depth and contrast.

**Palette.**
- Paper `#F4F2EC` · Card `#FFFFFF` · Ink `#0B0C0F` · Ink-2 `#3D4048` · Muted `#7D8089`
- Volt `#CDFF3F` (the highlighter: live states, "Met", key CTAs on dark)
- Node threads: Signal cobalt `#2F6BFF` · Trigger amber `#F29B0F` · Long `#0FA968` · Short `#EE4B37` · Exit graphite
- Dark mode is its own set of steps, not an inversion.

**Type.** Inter Tight (display + UI, tight tracking) · Instrument Serif italic for the
human words in headlines (thesis, believe, open) · JetBrains Mono for every number, label, and log.

**Motion principles.**
1. Woven, not dropped: the thread draws first, then the node arrives on it.
2. One easing family: `cubic-bezier(.22,1,.36,1)` for entrances, springs for interaction.
3. Data is alive: tickers drift, odds wobble, edges carry particles. Never frantic.
4. Nothing runs offscreen. Loops pause when out of view.
5. `prefers-reduced-motion`: every animation resolves to its final state, with no loops.
