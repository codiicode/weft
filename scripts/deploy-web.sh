#!/usr/bin/env bash
# Builds the static site and publishes it to Vercel (project "weft").
# Usage: scripts/deploy-web.sh            # production
#        scripts/deploy-web.sh --preview  # preview URL only
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
# The hosted API (Railway). Override with WEFT_API_URL=... or WEFT_API_URL= (empty) to build the app closed.
export NEXT_PUBLIC_API_URL="${WEFT_API_URL-https://weft-api-production.up.railway.app}"
if [ -z "$NEXT_PUBLIC_API_URL" ]; then
  echo "No API URL: building the app as closed (landing page live, app says it opens soon)."
  export NEXT_PUBLIC_APP_CLOSED=1
fi
npm run build -w @weft/web

# Deploy from a copy outside the repo: the Vercel CLI otherwise walks up and uploads the source tree.
TMP=$(mktemp -d)
cp -R apps/web/out/. "$TMP/"
cp -R apps/web/.vercel "$TMP/.vercel"
cat > "$TMP/vercel.json" <<'JSON'
{
  "framework": null,
  "buildCommand": "echo static",
  "installCommand": "echo skip",
  "outputDirectory": ".",
  "cleanUrls": true,
  "redirects": [
    { "source": "/:path*", "has": [{ "type": "host", "value": "www.weft.fi" }], "destination": "https://weft.fi/:path*", "permanent": true },
    { "source": "/", "has": [{ "type": "host", "value": "app.weft.fi" }], "destination": "/home", "permanent": false },
    { "source": "/app", "destination": "/home", "permanent": false },
    { "source": "/app/library", "destination": "/strategies", "permanent": false },
    { "source": "/app/live", "destination": "/accounts", "permanent": false },
    { "source": "/app/earnings", "destination": "/revenue", "permanent": false },
    { "source": "/app/runs", "destination": "/portfolio", "permanent": false },
    { "source": "/app/:path*", "destination": "/:path*", "permanent": false },
    { "source": "/library", "destination": "/strategies", "permanent": false },
    { "source": "/live", "destination": "/accounts", "permanent": false },
    { "source": "/runs", "destination": "/portfolio", "permanent": false }
  ],
  "trailingSlash": false,
  "headers": [
    { "source": "/_next/static/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
    { "source": "/(.*)", "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      { "key": "X-Frame-Options", "value": "DENY" }
    ] }
  ]
}
JSON
cd "$TMP"
if [ "${1:-}" = "--preview" ]; then npx -y vercel@latest deploy --yes; else npx -y vercel@latest deploy --prod --yes; fi
cd "$ROOT" && rm -rf "$TMP"
