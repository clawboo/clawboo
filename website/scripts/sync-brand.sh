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

# Screenshots are NOT vendored from docs/screenshots any more, on purpose.
#
# src/assets/screenshots now holds SIX PAIRS: a light and a dark capture of the
# same surface, shot back to back from one seeded database so the pair matches.
# docs/screenshots only ever had the light halves, and they are older. Copying
# them back would put a stale light shot next to a fresh dark one in the same
# <picture>, which is worse than either being out of date on its own, and the
# reader sees it the moment they hit the theme toggle.
#
# Replace the screenshots as a SET with the capture harness, which writes all
# twelve in one run. If docs/screenshots ever carries both halves, a loop over
# the twelve names restores this block in one line.
#
# hero-tight-final.webp and clawboo-mascot.png were copied here too and were
# deleted: nothing under src/ imports either. The README hero still lives at
# docs/screenshots/hero-tight-final.webp and is referenced from README.md.

echo "Done. NOTE: the vendored TS/CSS sources are hand-maintained:"
echo "  - src/lib/boo-avatar.ts            <- packages/boo-avatar/src/index.ts"
echo "  - src/components/atmosphere/*.tsx   <- apps/web/src/features/atmosphere/*"
echo "  - src/styles/tokens.css            <- apps/web/src/app/globals.css (:root + .dark)"
echo "Re-copy those by hand if the product versions change, preserving the local edits noted in each file."
