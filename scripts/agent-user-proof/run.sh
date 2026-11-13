#!/usr/bin/env bash
# Prove agent isolation (CLAWBOO_AGENT_USER) in a Linux container with two
# real users: a server user and an agent user.
#
# Run from anywhere, after `pnpm build`. Needs Docker. Each scenario prints
# PASS / FAIL lines; the script exits non-zero on any failure.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
IMAGE=${CLAWBOO_PROOF_IMAGE:-clawboo-agent-user-proof:local}
# Under the home, not /tmp: some Docker setups (colima) share only the home.
mkdir -p "$HOME/.cache"
OUT=$(mktemp -d "$HOME/.cache/clawboo-agent-proof.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(ls -d "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)
EXTERNALS=(--external:better-sqlite3 --external:ws --external:pino --external:pino-pretty
  --external:@composio/client '--external:@opentelemetry/*')
"$ESBUILD" "$ROOT/apps/web/server/agentHost/main.ts" --bundle --platform=node --format=cjs \
  --target=node22 --log-level=warning --outfile="$OUT/agent-host.js"
"$ESBUILD" "$HERE/proof.ts" --bundle --platform=node --format=cjs --target=node22 \
  --log-level=warning "${EXTERNALS[@]}" --outfile="$OUT/proof.cjs"
if [ -f "$ROOT/apps/web/dist/server.js" ]; then cp "$ROOT/apps/web/dist/server.js" "$OUT/server.js"; fi
cp "$HERE/fake-runtime.sh" "$HERE/fake-mcp.mjs" "$HERE/serverBoot.mjs" "$OUT/"
cp "$ROOT/apps/web/server/agentHost/clawboo-launch.sh" "$OUT/clawboo-launch"
chmod -R a+rX "$OUT"
chmod 755 "$OUT/clawboo-launch" "$OUT/fake-runtime.sh"

docker build -q -t "$IMAGE" "$HERE" >/dev/null

TOKEN=proof-token-0123456789abcdef
COMMON=(--rm --init -v "$OUT:/proof:ro" -e STUDIO_ACCESS_TOKEN=$TOKEN -e CLAWBOO_AGENT_USER=clawboo-agent
  -e CLAWBOO_AGENT_HOST_SCRIPT=/proof/agent-host.js -e PROOF_FAKE_RUNTIME=/proof/fake-runtime.sh
  -e PROOF_FAKE_MCP=/proof/fake-mcp.mjs)
fail=0
scenario() {
  echo
  echo "== $1"
  shift
  if ! "$@"; then fail=1; fi
}
expect_line() {
  local out=$1 pattern=$2 name=$3
  if grep -q -- "$pattern" <<<"$out"; then echo "PASS  $name"; else echo "FAIL  $name"; fail=1; fi
}

scenario "sudo: the server starts the agent host through one sudo rule" \
  docker run "${COMMON[@]}" --user 10001 -w /home/clawboo "$IMAGE" node /proof/proof.cjs sudo

scenario "sudo: without the sudoers rule, the server refuses to start" \
  docker run "${COMMON[@]}" "$IMAGE" sh -c \
  'rm /etc/sudoers.d/clawboo && cd /home/clawboo && exec setpriv --reuid=10001 --regid=10001 --clear-groups env HOME=/home/clawboo node /proof/proof.cjs refuse'

if [ -f "$OUT/server.js" ]; then
  scenario "the real server boots with agent isolation, and agents reach its MCP servers over HTTP" \
    docker run "${COMMON[@]}" --user 10001 -w /home/clawboo -e CLAWBOO_UI_DIR=/nonexistent "$IMAGE" \
    node /proof/serverBoot.mjs
fi

LAUNCH=(-e CLAWBOO_SERVER_USER=clawboo -e CLAWBOO_HOME=/data -e CLAWBOO_WORK_DIR=/work
  --security-opt no-new-privileges)

echo
echo "== launcher: socket mode under no-new-privileges, and it stops every agent process"
out=$(docker run "${COMMON[@]}" "${LAUNCH[@]}" "$IMAGE" sh -c \
  'mkdir -p /data /work && chown 10001:10001 /data /work && /proof/clawboo-launch node /proof/proof.cjs socket; echo "LAUNCHER_EXIT=$?"; echo "AGENT_PROCS=$(ps -u 10002 -o stat= | grep -vc ^Z)"' 2>&1 || true)
echo "$out" | grep -E '^(PASS|FAIL|warn|error)' || true
grep -q '^FAIL' <<<"$out" && fail=1
expect_line "$out" 'LAUNCHER_EXIT=0' 'the launcher exits with the server status'
expect_line "$out" 'AGENT_PROCS=0' 'no agent process survives the launcher'

echo
echo "== launcher: a hard link to the database in the work folder"
out=$(docker run "${COMMON[@]}" "${LAUNCH[@]}" "$IMAGE" sh -c \
  'mkdir -p /data /work/teams/t && echo db > /data/clawboo.db && ln /data/clawboo.db /work/teams/t/notes.txt && cp /bin/cat /work/teams/t/c && ln /work/teams/t/c /work/teams/t/c2 && chown -R 10001:10001 /data /work && chmod 4755 /work/teams/t/c && echo "BEFORE=$(stat -c %a /work/teams/t/c)" && /proof/clawboo-launch node /proof/proof.cjs socket-hardlink; echo "OWNER=$(stat -c %u /work/teams/t/notes.txt) WORK=$(stat -c %u /work) SUID=$(stat -c %a /work/teams/t/c)"' 2>&1 || true)
echo "$out" | grep -E '^(PASS|FAIL)' || true
grep -q '^FAIL' <<<"$out" && fail=1
expect_line "$out" 'left /work/teams/t/notes.txt as it was' 'the ownership pass leaves the hard link and names it'
expect_line "$out" 'OWNER=10001 WORK=10002' 'the work folder goes to the agent user, the hard link stays the server user'
expect_line "$out" 'BEFORE=4755' 'a setuid file was planted (owned by the server user, two hard links)'
expect_line "$out" 'SUID=755' 'a setuid file planted in the work folder loses its setuid bit'

echo
echo "== launcher: when the agent host dies, the server exits and nothing survives"
name=clawboo-proof-hostdeath-$$
DETACHED=()
for a in "${COMMON[@]}"; do [ "$a" = --rm ] || [ "$a" = --init ] || DETACHED+=("$a"); done
docker run -d --init --name "$name" "${DETACHED[@]}" "${LAUNCH[@]}" "$IMAGE" sh -c \
  'mkdir -p /data /work && chown 10001:10001 /data /work && /proof/clawboo-launch node /proof/proof.cjs socket-hostdeath; echo "LAUNCHER_EXIT=$?"; echo "AGENT_PROCS=$(ps -u 10002 -o stat= | grep -vc ^Z)"' >/dev/null
for _ in $(seq 1 120); do docker logs "$name" 2>&1 | grep -q READY && break; sleep 1; done
docker exec "$name" pkill -KILL -f agent-host.js || true
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Running}}' "$name")" = false ] && break; sleep 1; done
out=$(docker logs "$name" 2>&1)
docker rm -f "$name" >/dev/null 2>&1 || true
expect_line "$out" 'READY' 'the server was running with the host'
if grep -q 'LAUNCHER_EXIT=0' <<<"$out"; then echo "FAIL  the launcher exits non-zero"; fail=1; else echo "PASS  the launcher exits non-zero"; fi
expect_line "$out" 'AGENT_PROCS=0' 'no agent process survives'

echo
if [ "$fail" = 0 ]; then echo "agent isolation proof: all passed"; else echo "agent isolation proof: FAILED"; fi
exit "$fail"
