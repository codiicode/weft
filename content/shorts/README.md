# Short videos

Three shorts in the launch video's style, 1080p60 with a synthesised soundtrack:

| Video | Page | Length | What it shows |
|---|---|---|---|
| Tour | `tour.html` | 42 s | A thesis typed on /home, the draft, a 90-day backtest, Start, /portfolio, /markets, /traders |
| Copy a trader | `copy.html` | 28 s | /traders → Copy → a condition added in words → the draft → the running copy |
| What Weft watches | `sources.html` | 25 s | Eight sources, each with a live picture, then all of them woven into one knot |

`tour.html` and `copy.html` play back real frames of the app. `sources.html` is pure motion graphics.
`film.js` holds what they share: easing, the camera, masked type, grain, and the knot end card.

## What is real and what is demo

The app footage is the real web app, built in a demo mode (`NEXT_PUBLIC_DEMO_USER`) against
`mock-api.mjs`:

- **Real (proxied to the live API):** markets, traders, strategies, charts and backtests. The
  backtest in the tour is genuine: +16.5% over 90 days, 12 trades, 67% won.
- **Real drafts, replayed:** the AI drafts are real Weft output, recorded once (`recordings/draft-*.json`)
  and replayed so takes are repeatable.
- **Made up:** the signed-in account, its balances, runs, positions and activity. That's why the
  window bar says DEMO ACCOUNT.

## Re-recording

```bash
NEXT_PUBLIC_DEMO_USER="0x5e2b…91ad" NEXT_PUBLIC_API_URL=http://localhost:8788 npm run build -w @weft/web
cp -R apps/web/out /tmp/app-demo
node content/shorts/mock-api.mjs &
node content/shorts/serve-demo.mjs /tmp/app-demo 3100 &
node content/shorts/record-tour.mjs
node content/shorts/record-copy.mjs
```

Rebuild the web app normally afterwards (`scripts/deploy-web.sh` always does).

## Rendering

```bash
node content/launch-video/render.mjs --page content/shorts/tour.html --out content/shorts/out/ --name tour-video
node content/shorts/tour-audio.mjs
```

Then mux the two files with ffmpeg (loudnorm to −14 LUFS). Do the same for `copy` and `sources`.
`--stills 3.2,10` renders single frames for checking.
