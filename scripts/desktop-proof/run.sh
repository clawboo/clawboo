#!/usr/bin/env bash
# Prove a desktop per agent in a Linux container: each agent's own display, its
# browser on it, the live view, take over, and agent isolation (both with agents
# on the server's user and on their own OS user).
#
# Run from anywhere. Needs Docker. Prints PASS / FAIL lines and exits non-zero
# on any failure. Copies what the live view saw to $DESKTOP_PROOF_OUT (default
# a temporary folder it names).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
IMAGE=${CLAWBOO_DESKTOP_PROOF_IMAGE:-clawboo-desktop-proof:local}
# Under the home, not /tmp: some Docker setups (colima) share only the home.
mkdir -p "$HOME/.cache"
WORK=$(mktemp -d "$HOME/.cache/clawboo-desktop-proof.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/bundle"
OUTDIR="$WORK/out"
mkdir -p "$BUNDLE" "$OUTDIR"

ESBUILD=$(ls -d "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)
EXTERNALS=(--external:better-sqlite3 --external:ws --external:pino --external:pino-pretty
  --external:@composio/client '--external:@opentelemetry/*')
"$ESBUILD" "$ROOT/apps/web/server/agentHost/main.ts" --bundle --platform=node --format=cjs \
  --target=node22 --log-level=warning --outfile="$BUNDLE/agent-host.js"
# The proof also imports workspace packages by name, as apps/web resolves them.
NODE_PATH="$ROOT/apps/web/node_modules" "$ESBUILD" "$HERE/proof.ts" --bundle --platform=node --format=cjs --target=node22 \
  --log-level=warning "${EXTERNALS[@]}" --outfile="$BUNDLE/proof.cjs"
cp "$HERE/fake-browser-mcp.mjs" "$HERE/install-proof.sh" "$BUNDLE/"
chmod -R a+rX "$BUNDLE"
chmod 777 "$OUTDIR"

docker build -q -t "$IMAGE" "$HERE" >/dev/null

COMMON=(--rm --init --shm-size=512m -v "$BUNDLE:/proof:ro" -v "$OUTDIR:/out"
  -e CLAWBOO_AGENT_HOST_SCRIPT=/proof/agent-host.js -e CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes/rt
  -w /home/clawboo --user 10001)
fail=0

echo
echo "== agents on the server's own user"
docker run "${COMMON[@]}" "$IMAGE" node /proof/proof.cjs plain || fail=1

echo
echo "== agents on their own OS user (CLAWBOO_AGENT_USER)"
docker run "${COMMON[@]}" -e CLAWBOO_AGENT_USER=clawboo-agent -e STUDIO_ACCESS_TOKEN=proof-token-0123456789abcdef \
  "$IMAGE" node /proof/proof.cjs agent || fail=1

echo
echo "== the desktop tools install, from the real releases (x86_64, so TigerVNC is included)"
# TigerVNC publishes its Linux build for x86_64 only, so this runs on x86_64
# (emulated on an arm64 machine), on a stock image set up by install-proof.sh.
docker run --rm --init --platform linux/amd64 -v "$BUNDLE:/proof:ro" node:22-bookworm-slim \
  bash /proof/install-proof.sh || fail=1

DEST=${DESKTOP_PROOF_OUT:-$(mktemp -d "$HOME/.cache/clawboo-desktop-proof-out.XXXXXX")}
mkdir -p "$DEST"
cp "$OUTDIR"/*.png "$DEST"/ 2>/dev/null || true
echo
echo "what the live view saw: $DEST"
if [ "$fail" = 0 ]; then echo "desktop proof: all passed"; else echo "desktop proof: FAILED"; fi
exit "$fail"
