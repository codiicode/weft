# Weft launch video, v4: storyboard

**Format:** 1920×1080, 60 fps, 78.6 seconds, no voice-over (X autoplays muted), large on-screen type.
**Music:** "Goldn" by kontraa (UK drill, 146 BPM, Pixabay Content License; see `content/music/README.md`),
from 0:00 with a fade-out over the end card, loudness −14 LUFS. The cuts sit on its bars. No sound effects.
**Look:** the site's palette and fonts, the five-threads-into-one-knot motif, and one colour per data
source so the viewer can follow each condition from the sentence into the diagram.
**Craft rules:** no fades to black: every cut is motivated (a zoom through the knot, a shared-element
flight, a pan with motion blur, a line-of-light wipe, a collapse into a point). Type slides up from behind
masks. Hairlines, letter-spaced small caps and tabular numbers; no pill badges or status dots. Glowing heads
on lines as they draw, bloom on the knot, a little film grain and a vignette.

| Time | Scene | What happens |
|---|---|---|
| 0–3.5 s | **Logo** | Five threads draw with glowing heads, rings close in, the knot snaps tight, one green thread leaves. "weft", "Trade the thesis." The camera dives through the knot. |
| 3.2–6.7 s | **Hook** | "You know what should happen." / "You just can't watch everything at once." Live readings (prices, odds, posts, funding…) flicker on all around, then rush into the middle. |
| 6.5–15 s | **The sentence** | They condense into the input. The Elon / TSLA sentence is typed; nine phrases are underlined in their source's colour. On send, the phrases lift off the sentence. |
| 15–24 s | **Every phrase becomes a rule** | The nine phrases fly across and become the nine boxes; threads weave into a segmented knot → *Long TSLA 10×* → three exits. |
| 24–35 s | **Then it watches** | Live values and sparklines; as each condition turns true a green line runs round its box and a segment of the knot lights. The camera creeps in. The post arrives, the knot fires with a bloom, *filled at $352.90*, exits arm. |
| 35–46 s | **Any signal. Any market. One sentence.** | Zoom through the knot into a strip of three diagrams that pans with motion blur: copy a trader gated by Fear & Greed and BTC; three smart wallets + on-chain; Polymarket + rates + Fear & Greed into two trades. |
| 46–52 s | **Not just prices** | The strip pans on to twelve sources, each a thread woven into one knot ("one sentence"), signals running down every thread. |
| 52–58 s | **Copy the best** | A line of light wipes across. Leaderboard, cursor, Copy. Two timelines: their BTC long, your mirrored copy, they close, you close (+8.2% / +8.1%). |
| 58–64 s | **Or let it build a portfolio** | "Build a stock portfolio of the companies you believe in most for Q4. Use $10,000…" Seven stocks appear with their weights (NVIDIA, Microsoft, Alphabet, Meta, Broadcom, Tesla, SpaceX, as Weft's drafter picked them), then each order fills; sells everything on Dec 31. |
| 64–69 s | **Or keep it simple** | Wipe. "Long ETH 20x with $100 now." Four words drop into an order ticket; size and entry roll in; filled. |
| 69–73 s | **Safety** | The camera drops down. Orders flow into your account; a withdrawal hits a lock twice: "not permitted". Everything collapses into a point. |
| 73–78.6 s | **End card** | The threads and knot from that point, weft.fi, Live now, the four markets. |

Honest details: Weft reads @elonmusk's posts on X (not what is said on stage), and the video only shows
that a post *matched*, never invented text. Trader and wallet addresses are made up. Prices are close to
real at the time of writing (TSLA ≈ $353).

**Files**
- `video.html`: the film; `renderAt(seconds)` draws any frame exactly. `video-v1.html` is the first cut.
- Music: `content/music/kontraa-goldn-uk-drill-music-116392.mp3`, muxed with ffmpeg (trim to 78.6 s, fade out from 75.6 s, loudnorm −14 LUFS). `audio.mjs` is the old synthesised score, no longer used.
- `render.mjs`: frame-by-frame render → `out/weft-launch.mp4`; `--stills 12,30` for single frames.
