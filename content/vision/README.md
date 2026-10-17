# Vision film (41.9 s)

The intro film: what Weft is for, not how it works. One gold thread runs through the history of trading and draws each era as it passes, then everything comes down to a sentence.

| t (s) | Scene |
|---|---|
| 0.4–18.1 | **History.** One era every six beats: 600 BCE Lydia (first coins), 1602 Amsterdam (first share), 1792 Wall Street (Buttonwood), 1867 New York (ticker), 1971 Nasdaq (screens), 2009 (blocks), Now (a phone in a flood of live numbers). |
| 18.1–21.9 | **The turn.** "Every era found a new way to trade. / Ours starts with a sentence." |
| 21.7–35.6 | **The vision.** The sentence "AI keeps eating software. What's the trade?" is typed. The world's signals gather round it and fall in, then become threads that tie into the knot on the drop (28.0). Markets come into orbit, and the thesis lands on three of them. "Weft watches it all. / And trades it from your own wallet." Zoom through the knot. |
| 35.6–41.9 | **End.** weft, weft.fi, "Trade the thesis." |

## Music

Goldn by kontraa (see `content/music/README.md`). The track is cut on bar lines:

- 0–18.112 s of the track (intro into the full beat) plays under the history.
- It cuts on bar 11 to the break at 42.77 s, which is quiet under the turn and the typing.
- The beat comes back (track 52.64 s) at film 27.98 s, when the knot forms.

```bash
node content/launch-video/render.mjs --page content/vision/vision.html --out content/vision/out/ --name weft-vision-silent
```

Then `bash content/vision/mux.sh` splices the music and writes `out/weft-vision.mp4`.
