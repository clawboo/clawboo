#!/bin/sh
# clawboo-launch: run Clawboo and its agent host as two users in a container.
#
# Run as root, as the container's entrypoint (with `--init` or tini as PID 1).
# It works under `--security-opt no-new-privileges`, which rules out sudo: it
# only DROPS privileges, once for each process, with setpriv (or gosu).
#
#   CLAWBOO_SERVER_USER=clawboo CLAWBOO_AGENT_USER=clawboo-agent \
#   CLAWBOO_HOME=/data CLAWBOO_WORK_DIR=/work clawboo-launch [server command ...]
#
# The server command defaults to `node <this folder>/server.js`.
#
# What it does (the contract the server checks before it connects):
# 1. Makes the run folder (CLAWBOO_RUN_DIR, default /run/clawboo) owned by the
#    agent user and the server's group, mode 0710.
# 2. On first start, gives the work folder to the agent user, leaving any file
#    with more than one hard link as it was and naming it (an agent that once
#    ran as the server's user could have linked the database in). Narrows the
#    data folder to 0700.
# 3. Starts the agent host as the agent user; the socket it makes is given the
#    server's group, mode 0660.
# 4. Starts the server as the server user, with CLAWBOO_AGENT_USER and
#    CLAWBOO_AGENT_HOST_SOCKET set and its environment otherwise unchanged. The
#    agent host gets only PATH, HOME, locale and the socket path.
# 5. When either process exits, stops the other, stops every process the agent
#    user owns, and exits, so the container's restart policy starts both again.
#
# It never passes a secret on a command line.

set -eu

die() {
  echo "clawboo-launch: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "run me as root (the container entrypoint); I start the server and the agent host as two users"

SERVER_USER=${CLAWBOO_SERVER_USER:-}
AGENT_USER=${CLAWBOO_AGENT_USER:-}
[ -n "$SERVER_USER" ] || die "set CLAWBOO_SERVER_USER to the user the server runs as"
[ -n "$AGENT_USER" ] || die "set CLAWBOO_AGENT_USER to the user agents run as"

RUN_DIR=${CLAWBOO_RUN_DIR:-/run/clawboo}
SOCK="$RUN_DIR/agent.sock"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST_JS=${CLAWBOO_AGENT_HOST_SCRIPT:-$HERE/agent-host.js}
NODE=${CLAWBOO_NODE:-$(command -v node || true)}
[ -n "$NODE" ] || die "node is not on PATH; set CLAWBOO_NODE"
[ -f "$HOST_JS" ] || die "$HOST_JS is missing"

server_uid=$(id -u "$SERVER_USER") || die "no such user: $SERVER_USER"
server_gid=$(id -g "$SERVER_USER")
agent_uid=$(id -u "$AGENT_USER") || die "no such user: $AGENT_USER"
agent_gid=$(id -g "$AGENT_USER")
[ "$server_uid" != 0 ] || die "the server must not run as root"
[ "$agent_uid" != 0 ] || die "the agent user must not be root"
[ "$server_uid" != "$agent_uid" ] || die "the server and the agents need two different users"

home_of() {
  getent passwd "$1" 2>/dev/null | cut -d: -f6
}
server_home=$(home_of "$SERVER_USER")
agent_home=$(home_of "$AGENT_USER")
[ -n "$agent_home" ] || agent_home=/nonexistent

# Run a command as <uid> <gid>, with no supplementary groups.
as_user() {
  uid=$1
  gid=$2
  shift 2
  if command -v setpriv >/dev/null 2>&1; then
    exec_cmd="setpriv --reuid=$uid --regid=$gid --clear-groups --"
  elif command -v gosu >/dev/null 2>&1; then
    exec_cmd="gosu $uid:$gid"
  else
    die "neither setpriv nor gosu is installed"
  fi
  # shellcheck disable=SC2086
  $exec_cmd "$@"
}

# Stop every process the agent user owns, three times (a fork loop can outrun one).
kill_agents() {
  for _ in 1 2 3; do
    as_user "$agent_uid" "$agent_gid" kill -KILL -1 2>/dev/null || true
  done
}

# 1. The run folder.
mkdir -p "$RUN_DIR"
chown "$agent_uid:$server_gid" "$RUN_DIR"
chmod 0710 "$RUN_DIR"
rm -f "$SOCK"

# 2. The work folder and the data folder.
if [ -n "${CLAWBOO_WORK_DIR:-}" ]; then
  mkdir -p "$CLAWBOO_WORK_DIR"
  owner=$(stat -c %u "$CLAWBOO_WORK_DIR")
  if [ "$owner" != "$agent_uid" ]; then
    echo "clawboo-launch: giving $CLAWBOO_WORK_DIR to $AGENT_USER (first start)" >&2
    find "$CLAWBOO_WORK_DIR" -xdev -type f -links +1 -print | while IFS= read -r f; do
      echo "clawboo-launch: left $f as it was: it has more than one hard link" >&2
    done
    find "$CLAWBOO_WORK_DIR" -xdev ! \( -type f -links +1 \) -exec chown -h "$agent_uid:$agent_gid" {} +
  fi
  chmod 0700 "$CLAWBOO_WORK_DIR"
fi
if [ -n "${CLAWBOO_HOME:-}" ] && [ -d "$CLAWBOO_HOME" ]; then
  chmod 0700 "$CLAWBOO_HOME"
fi

# Nothing the agent user ran before this start survives it.
kill_agents

# 3. The agent host.
as_user "$agent_uid" "$agent_gid" env -i \
  PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
  HOME="$agent_home" \
  LANG="${LANG:-C.UTF-8}" \
  CLAWBOO_AGENT_HOST_SOCKET="$SOCK" \
  "$NODE" "$HOST_JS" &
host_pid=$!

tries=0
while [ ! -S "$SOCK" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ] || ! kill -0 "$host_pid" 2>/dev/null; then
    kill_agents
    die "the agent host did not start"
  fi
  sleep 0.1
done
chown "$agent_uid:$server_gid" "$SOCK"
chmod 0660 "$SOCK"

# 4. The server.
if [ "$#" -eq 0 ]; then
  set -- "$NODE" "$HERE/server.js"
fi
as_user "$server_uid" "$server_gid" env \
  HOME="${server_home:-/nonexistent}" \
  USER="$SERVER_USER" \
  LOGNAME="$SERVER_USER" \
  CLAWBOO_AGENT_USER="$AGENT_USER" \
  CLAWBOO_AGENT_HOST_SOCKET="$SOCK" \
  "$@" &
server_pid=$!

stop() {
  kill -TERM "$server_pid" 2>/dev/null || true
}
trap stop TERM INT

# 5. When either exits, stop the other and every agent process, then exit.
while kill -0 "$server_pid" 2>/dev/null && kill -0 "$host_pid" 2>/dev/null; do
  sleep 1
done
if kill -0 "$server_pid" 2>/dev/null; then
  echo "clawboo-launch: the agent host exited; stopping the server" >&2
  kill -TERM "$server_pid" 2>/dev/null || true
  i=0
  while kill -0 "$server_pid" 2>/dev/null && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
  kill -KILL "$server_pid" 2>/dev/null || true
fi
status=0
wait "$server_pid" 2>/dev/null || status=$?
kill_agents
wait "$host_pid" 2>/dev/null || true
exit "$status"
