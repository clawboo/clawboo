#!/usr/bin/env bash
# The desktop tools install proof, on x86_64 (where TigerVNC publishes its build):
# set up a stock Node image as root, then run the proof as an unprivileged
# server user. Run by run.sh; the bundle is mounted at /proof.
set -euo pipefail
apt-get update -qq
# What TigerVNC's own Linux build loads from the system, plus xdpyinfo.
apt-get install -y -qq --no-install-recommends ca-certificates procps \
  libxshmfence1 libxcvt0 libgbm1 libx11-6 libxi6 libxkbcommon0 x11-xkb-utils xkb-data x11-utils >/dev/null
mkdir -p /opt/clawboo && cd /opt/clawboo && npm init -y >/dev/null
npm install --omit=dev --no-audit --no-fund --loglevel=error \
  better-sqlite3@12.11.1 ws@8.21.3 pino@^10.4.0 pino-pretty@^13.2.0 @composio/client@0.1.0-alpha.76 >/dev/null
groupadd -g 10001 clawboo && useradd -u 10001 -g 10001 -m -d /home/clawboo -s /bin/bash clawboo
mkdir -p /opt/clawboo-runtimes && chown 10001:10001 /opt/clawboo-runtimes && chmod 755 /opt/clawboo-runtimes
cd /home/clawboo
exec setpriv --reuid=10001 --regid=10001 --clear-groups \
  env HOME=/home/clawboo PATH="$PATH" NODE_PATH=/opt/clawboo/node_modules \
  CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes/rt node /proof/proof.cjs install
