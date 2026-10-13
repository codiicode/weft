#!/usr/bin/env bash
# Builds the static site and publishes it to Vercel (project "weft").
# Usage: scripts/deploy-web.sh            # production
#        scripts/deploy-web.sh --preview  # preview URL only
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
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
