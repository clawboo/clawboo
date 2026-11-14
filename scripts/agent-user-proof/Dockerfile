# A Linux image with two users, for proving agent isolation (CLAWBOO_AGENT_USER)
# end to end: `clawboo` runs the server, `clawboo-agent` runs the agents.
# Built and run by run.sh; nothing here is published.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo git procps sqlite3 ca-certificates \
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

# The published package's native and external dependencies, where both users can
# run them (never under a home).
RUN mkdir -p /opt/clawboo && cd /opt/clawboo \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund better-sqlite3@12.11.1 ws@8.21.3 pino@^10.4.0 pino-pretty@^13.2.0 @composio/client@0.1.0-alpha.76 \
 && chmod -R a+rX /opt/clawboo

ENV NODE_PATH=/opt/clawboo/node_modules
