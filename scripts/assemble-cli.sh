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

if [ ! -f "$WEB_DIST/mcp/tasks.js" ]; then
  echo "ERROR: $WEB_DIST/mcp/tasks.js not found."
  echo "Run 'pnpm build' first (builds the bundled MCP stdio bins)."
  exit 1
fi

# ── Copy server bundle ───────────────────────────────────────────────────

echo "Copying server.js → $CLI_DIST/"
cp "$WEB_DIST/server.js" "$CLI_DIST/server.js"

# ── Copy UI assets ───────────────────────────────────────────────────────

echo "Copying ui/ → $CLI_DIST/ui/"
rm -rf "$CLI_DIST/ui"
cp -r "$WEB_DIST/ui" "$CLI_DIST/ui"

# ── Copy MCP stdio bins ──────────────────────────────────────────────────
# Self-contained bundles → an external runtime can spawn `clawboo-mcp-tasks`
# (etc.) from a clean `npx clawboo` install.

echo "Copying MCP stdio bins → $CLI_DIST/bin/"
rm -rf "$CLI_DIST/bin"
mkdir -p "$CLI_DIST/bin"
cp "$WEB_DIST/mcp/tasks.js" "$CLI_DIST/bin/tasks.js"
cp "$WEB_DIST/mcp/memory.js" "$CLI_DIST/bin/memory.js"
cp "$WEB_DIST/mcp/tools.js" "$CLI_DIST/bin/tools.js"
cp "$WEB_DIST/mcp/teamchat.js" "$CLI_DIST/bin/teamchat.js"

# ── Verify ───────────────────────────────────────────────────────────────

echo ""
echo "Assembly complete:"
ls -lh "$CLI_DIST/index.js" "$CLI_DIST/server.js" "$CLI_DIST/ui/index.html" "$CLI_DIST/bin/tasks.js"
echo ""
echo "Test with: node $CLI_DIST/index.js"
