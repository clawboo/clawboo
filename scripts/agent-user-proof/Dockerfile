# A Linux image for proving agent isolation end to end: `clawboo` runs the
# server; `clawboo-agent` runs every agent (CLAWBOO_AGENT_USER); `clawboo-a1` to
# `clawboo-a3` are a pool with a user per agent (CLAWBOO_AGENT_USERS), sharing
# team folders through the groups `clawboo-t1` and `clawboo-t2`.
# Built and run by run.sh; nothing here is published.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo git procps sqlite3 ca-certificates acl \
 && rm -rf /var/lib/apt/lists/*

# The server user, and the agent user with a group of its own and no password.
RUN groupadd -g 10001 clawboo \
 && useradd -u 10001 -g 10001 -m -d /home/clawboo -s /bin/bash clawboo \
 && chmod 750 /home/clawboo \
 && groupadd -g 10002 clawboo-agent \
 && useradd -u 10002 -g 10002 -m -d /var/lib/clawboo-agent -s /bin/bash clawboo-agent \
 && passwd -l clawboo-agent \
 && chmod 700 /var/lib/clawboo-agent

# The one sudoers rule the setup prints (clawboo agent-user plan).
RUN printf '%s\n' 'clawboo ALL=(clawboo-agent) NOPASSWD: ALL' 'Defaults:clawboo !requiretty' > /etc/sudoers.d/clawboo \
 && chmod 440 /etc/sudoers.d/clawboo \
 && visudo -cf /etc/sudoers.d/clawboo

# The pool: each agent user with a group of its own and a private home, the
# team groups held by nobody but the server user, the server user in every
# group it makes folders for, and the one sudo rule a pool needs (users named
# inline: sudo takes `-g <team group>` only then). A work folder of the
# server's, outside every home.
RUN mkdir -p /var/lib/clawboo-agents \
 && for n in 1 2 3; do \
      groupadd -g 2000$n clawboo-a$n \
      && useradd -u 2000$n -g 2000$n -m -d /var/lib/clawboo-agents/a$n -s /bin/bash clawboo-a$n \
      && passwd -l clawboo-a$n \
      && chmod 700 /var/lib/clawboo-agents/a$n; \
    done \
 && groupadd -g 21001 clawboo-t1 && groupadd -g 21002 clawboo-t2 \
 && usermod -aG clawboo-a1,clawboo-a2,clawboo-a3,clawboo-t1,clawboo-t2 clawboo \
 && printf '%s\n' 'clawboo ALL=(clawboo-a1, clawboo-a2, clawboo-a3 : clawboo-t1, clawboo-t2) NOPASSWD: ALL' > /etc/sudoers.d/clawboo-pool \
 && chmod 440 /etc/sudoers.d/clawboo-pool \
 && visudo -cf /etc/sudoers.d/clawboo-pool \
 && install -d -o clawboo -g clawboo -m 711 /srv/clawboo-work

# The published package's native and external dependencies, where both users can
# run them (never under a home).
RUN mkdir -p /opt/clawboo && cd /opt/clawboo \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund better-sqlite3@12.11.1 ws@8.21.3 pino@^10.4.0 pino-pretty@^13.2.0 @composio/client@0.1.0-alpha.76 \
 && chmod -R a+rX /opt/clawboo

ENV NODE_PATH=/opt/clawboo/node_modules
