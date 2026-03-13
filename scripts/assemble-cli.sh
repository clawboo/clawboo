#!/usr/bin/env bash
set -euo pipefail

# ── assemble-cli.sh ──────────────────────────────────────────────────────
# Copies the bundled server.js and Vite UI output into apps/cli/dist/
# so that `npx clawboo` has everything it needs.
#
# Prerequisites: pnpm build must have completed successfully.
# ─────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WEB_DIST="$ROOT/apps/web/dist"
CLI_DIST="$ROOT/apps/cli/dist"

# ── Verify build artifacts exist ─────────────────────────────────────────

if [ ! -f "$WEB_DIST/server.js" ]; then
  echo "ERROR: $WEB_DIST/server.js not found."
  echo "Run 'pnpm build' first (builds UI + server)."
  exit 1
fi

if [ ! -f "$WEB_DIST/ui/index.html" ]; then
  echo "ERROR: $WEB_DIST/ui/index.html not found."
  echo "Run 'pnpm build' first (builds UI + server)."
  exit 1
fi

if [ ! -f "$CLI_DIST/index.js" ]; then
  echo "ERROR: $CLI_DIST/index.js not found."
  echo "Run 'pnpm build' first (builds CLI)."
  exit 1
fi

# ── Copy server bundle ───────────────────────────────────────────────────

echo "Copying server.js → $CLI_DIST/"
cp "$WEB_DIST/server.js" "$CLI_DIST/server.js"

# ── Copy UI assets ───────────────────────────────────────────────────────

echo "Copying ui/ → $CLI_DIST/ui/"
rm -rf "$CLI_DIST/ui"
cp -r "$WEB_DIST/ui" "$CLI_DIST/ui"

# ── Verify ───────────────────────────────────────────────────────────────

echo ""
echo "Assembly complete:"
ls -lh "$CLI_DIST/index.js" "$CLI_DIST/server.js" "$CLI_DIST/ui/index.html"
echo ""
echo "Test with: node $CLI_DIST/index.js"
