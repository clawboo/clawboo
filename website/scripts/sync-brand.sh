#!/usr/bin/env bash
# Re-vendor brand assets from the product into the website. Run manually when
# the product's mascot, atmosphere, screenshots, or fonts change. Read-only with
# respect to the product (only copies OUT of apps/web and docs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB="$ROOT/apps/web"
SITE="$ROOT/website"

echo "Re-vendoring brand assets from $WEB into $SITE ..."

# Public brand assets.
cp "$WEB/public/favicon.svg" "$SITE/public/"
cp "$WEB/public/favicon.ico" "$SITE/public/"
cp "$WEB/public/favicon-16.png" "$SITE/public/"
cp "$WEB/public/favicon-32.png" "$SITE/public/"
cp "$WEB/public/apple-touch-icon.png" "$SITE/public/"
cp "$WEB/public/logo.svg" "$SITE/public/"
cp "$WEB/public/og-card.jpg" "$SITE/public/"
cp "$WEB/public/fonts/GeistMono-Variable.woff2" "$SITE/public/fonts/"

# Screenshots.
for f in hero-tight-final.webp team-space.png ghost-graph.png agent-detail.png \
         capabilities-panel.png shared-memory.png runtimes-panel.png clawboo-mascot.png; do
  cp "$ROOT/docs/screenshots/$f" "$SITE/src/assets/screenshots/"
done

echo "Done. NOTE: the vendored TS/CSS sources are hand-maintained:"
echo "  - src/lib/boo-avatar.ts            <- packages/boo-avatar/src/index.ts"
echo "  - src/components/atmosphere/*.tsx   <- apps/web/src/features/atmosphere/*"
echo "  - src/styles/tokens.css            <- apps/web/src/app/globals.css (:root + .dark)"
echo "Re-copy those by hand if the product versions change, preserving the local edits noted in each file."
