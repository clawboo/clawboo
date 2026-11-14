# A Linux image for proving a desktop per agent end to end: TigerVNC's Xvnc as
# each agent's display, a window manager, Chromium as the agent's browser, and
# the same two users as the agent isolation proof (`clawboo` runs the server,
# `clawboo-agent` runs the agents). Built and run by run.sh; nothing here is
# published, and nothing here is what Clawboo asks a person to install.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo procps ca-certificates \
      tigervnc-standalone-server openbox dbus x11-utils xterm chromium fonts-dejavu-core \
      libxshmfence1 libxcvt0 libgbm1 x11-xkb-utils xkb-data at-spi2-core \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 clawboo \
 && useradd -u 10001 -g 10001 -m -d /home/clawboo -s /bin/bash clawboo \
 && chmod 750 /home/clawboo \
 && groupadd -g 10002 clawboo-agent \
 && useradd -u 10002 -g 10002 -m -d /var/lib/clawboo-agent -s /bin/bash clawboo-agent \
 && passwd -l clawboo-agent \
 && chmod 700 /var/lib/clawboo-agent

RUN printf '%s\n' 'clawboo ALL=(clawboo-agent) NOPASSWD: ALL' 'Defaults:clawboo !requiretty' > /etc/sudoers.d/clawboo \
 && chmod 440 /etc/sudoers.d/clawboo \
 && visudo -cf /etc/sudoers.d/clawboo

RUN mkdir -p /opt/clawboo && cd /opt/clawboo \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund better-sqlite3@12.11.1 ws@8.21.3 pino@^10.4.0 pino-pretty@^13.2.0 @composio/client@0.1.0-alpha.76 \
 && chmod -R a+rX /opt/clawboo

# Where Clawboo installs the desktop tools in the install proof: outside every
# home, owned by the server user, readable and runnable by the agent user.
RUN mkdir -p /opt/clawboo-runtimes && chown 10001:10001 /opt/clawboo-runtimes && chmod 755 /opt/clawboo-runtimes

ENV NODE_PATH=/opt/clawboo/node_modules
