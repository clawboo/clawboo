---
title: System maintenance
description: 'The System panel: the default command-approval posture, OpenClaw and Node versions, and Check for Updates.'
---

Use the **System** panel to set the default command-approval posture for OpenClaw agents and to see (and update) your OpenClaw install. It is a small panel: two cards, nothing else. The OpenClaw [Gateway](/appendices/glossary) process controls, the default-model picker, and the provider API keys used to live here and have each moved to the surface that owns them; see [What moved, and where it went](#what-moved-and-where-it-went) below.

Everything on this page is `MaintenancePanel` (`features/maintenance/`) talking to the `/api/system/*` routes. The panel reads `GET /api/system/status` on mount, its Command Approval section reads `GET /api/system/openclaw-config` and writes back through `PATCH /api/system/openclaw-config`, and **Check for Updates** streams SSE `POST /api/system/install-openclaw`. It never calls `POST /api/system/gateway`.

## Prerequisites

<Note>
The System panel is built for the OpenClaw path. The **Command Approval** section renders only when a live Gateway `client` is connected _and_ the current value could be read from `openclaw.json`; if you are running native-only (no Gateway), the panel is just the System Info card.
</Note>

- OpenClaw installed (the System Info section shows the detected version, or "Not installed").
- The dashboard running (`clawboo`); the System panel lives in the Settings modal.

## Where it lives

Open **Settings** (the gear at the bottom of the sidebar, or `Cmd/Ctrl + ,`), then **System** under the System group. The panel is a single scrollable column of two cards: Command Approval and System Info.

## What moved, and where it went

Earlier releases stacked seven sections here. Five of them now live on the surface that owns them, so the setting sits next to the thing it configures instead of in a catch-all panel:

| What you are looking for                 | Where it lives now                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Gateway status and **Restart**           | Settings → **Runtimes** → the OpenClaw row → **Manage**, in its **Gateway** block   |
| Starting a stopped Gateway               | the same row's **Reconnect** action (there is no **Manage** body while offline)     |
| Stopping the Gateway                     | the same row's **Disconnect** action (there is no standalone Stop button)           |
| Default model for OpenClaw agents        | that same **Manage** body, under **Default model**                                  |
| Provider API keys                        | Settings → **Providers** (see [Connecting runtimes](/runtimes/connecting-runtimes)) |
| Boo Zero's display name and global brief | Boo Zero's own agent view, **Brief** tab (see [Boo Zero](/using/boo-zero))          |
| A team's brief and rules                 | the gear on that team's chat header ("Team brief & rules")                          |
| Agent-to-agent coordination              | nothing to turn on: it is always enabled                                            |

<Note>
There is no agent-coordination switch anywhere in the dashboard. Agent-to-agent tooling is enabled unconditionally: onboarding writes `tools.agentToAgent.enabled: true` (and `tools.sessions.visibility: "all"`) into `openclaw.json` when it configures OpenClaw, and team deploys re-assert it. It is the core of the product, not a togglable option.
</Note>

## Steps

### Set the default command approval

The **Command Approval** section is one dropdown. It sets `tools.exec.ask` in `openclaw.json`, the default posture every OpenClaw agent inherits before running a shell command.

| Option              | Written value | What it means                                         |
| ------------------- | ------------- | ----------------------------------------------------- |
| **Run Freely**      | `off`         | Agents execute commands without asking                |
| **Ask for Unknown** | `on-miss`     | Agents ask approval for commands not in the allowlist |
| **Always Ask**      | `always`      | Agents ask approval for every command                 |

1. Pick an option. The dropdown updates immediately (optimistically) and disables itself while the write is in flight.
2. The panel sends `PATCH /api/system/openclaw-config` with `{ exec: { ask } }`, and a toast confirms **Default command approval set to "…"**.
3. If the write fails, the dropdown snaps back to its previous value and you get a **Failed to update Gateway config** toast.

After a successful write the panel makes a best-effort `config.get()` call on the Gateway `client`. That call is advisory: it is wrapped in its own `try`/`catch`, so a disconnected Gateway changes nothing about the outcome, and the new value is already on disk in `openclaw.json` either way.

<Tip>
This is the fleet-wide default. A single agent overrides it in its detail view's **Permissions** tab, under **Execution Permissions**; that override is per-agent and takes effect on the agent's next message. See [Approvals](/using/approvals) for what happens when an agent does ask.
</Tip>

### Check version and updates

The **System Info** section shows the OpenClaw version (or "Not installed"), the Node.js version, OpenClaw's state dir (`~/.openclaw` by default), and whether `openclaw.json` was found, all from a single `GET /api/system/status` read on mount. This card does not poll; it re-reads only after a successful update.

**Check for Updates** runs the OpenClaw installer in place: it streams `POST /api/system/install-openclaw` (which runs `npm install -g openclaw@^2026.5`) as SSE, renders every `progress` and `output` line in the update log below the button, and on success re-fetches status so the version row shows the new value.

## Options / variations

| Section           | What it writes                      | Backing route                                  |
| ----------------- | ----------------------------------- | ---------------------------------------------- |
| Command Approval  | `tools.exec.ask` in `openclaw.json` | `PATCH /api/system/openclaw-config` `{ exec }` |
| Check for Updates | reinstalls OpenClaw globally        | `POST /api/system/install-openclaw` (SSE)      |

## Verify it worked

- **Command Approval**: a toast reads **Default command approval set to "…"**; `GET /api/system/openclaw-config` returns the new value at `config.tools.exec.ask`.
- **Check for Updates**: the log ends with a success toast (**Updated to `<version>`**) and the System Info **OpenClaw** row shows the new version.

## Troubleshooting

<Warning>
**The Command Approval section is missing.** It renders only when a Gateway `client` is connected and the current `tools.exec.ask` could be read from `openclaw.json`. If you are native-only, or the Gateway is stopped, it is hidden by design and the panel shows System Info alone.
</Warning>

<Warning>
**Nothing here starts the Gateway.** The System panel no longer controls the Gateway process. Go to Settings → **Runtimes** and read the OpenClaw row. If the Gateway is running, expand the row's **Manage** body and use **Restart** in its **Gateway** block. If the Gateway is stopped there is no **Manage** body at all: the row reads **Disconnected** and its action is **Reconnect**. That reveals a short body with a **Reconnect OpenClaw** button, which reruns the inline setup non-destructively (your existing `openclaw.json` and credential are reused, nothing is re-asked) and starts the Gateway back up. The backing route is unchanged: `POST /api/system/gateway` with `{ action: "start" | "restart" }` is an SSE stream that polls the port for up to 60 seconds, and `{ action: "stop" }` is a plain JSON call returning `{ ok: true, stopped: true }` on success.
</Warning>

<Danger>
**Check for Updates reinstalls globally.** It runs `npm install -g`, which can hit `EACCES` on a system Node install. If the log shows a permission error, prefer a Node version manager (nvm/fnm) or Homebrew over `sudo`. Pinning is to `openclaw@^2026.5` to stay protocol-compatible with this Clawboo.
</Danger>

## See also

- [Connecting runtimes](/runtimes/connecting-runtimes), the Runtimes panel and the Providers hub that now hold the gateway controls, the default-model picker, and the provider keys
- [OpenClaw](/runtimes/openclaw), the Gateway runtime, device pairing, and channels
- [Approvals](/using/approvals), the queue that `tools.exec.ask` feeds
- [Boo Zero](/using/boo-zero), where the display name, global brief, and team rules editors live
- [`/api/system/*` reference](/reference/rest-api/system), full request/response shapes for every route on this page
