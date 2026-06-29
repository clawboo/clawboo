---
title: 'Quickstart: the OpenClaw Gateway'
description: Run npx clawboo, let onboarding detect, install, and configure OpenClaw, start the Gateway, approve the device, then deploy a team.
---

By the end of this tutorial you'll have a running OpenClaw Gateway driving a deployed team of agents, set up entirely from Clawboo's onboarding wizard: detect your environment, install OpenClaw if needed, configure a model provider, start the Gateway, approve the one-time device pairing, and deploy a starter team into group chat.

This is the OpenClaw path. Unlike the other four runtimes, [OpenClaw](/runtimes/openclaw) is a _connected substrate_; Clawboo connects to a running OpenClaw Gateway (a WebSocket server that hosts OpenClaw agents), rather than installing and spawning a CLI per task. If you want a working team with no Gateway at all, the [native runtime quickstart](/getting-started/quickstart-native) is faster: paste one provider key and you're done.

<Note>
These docs describe Clawboo **v0.2.0**, the current release.
</Note>

## Prerequisites

<Note>
- **Node.js 22 or newer**: Clawboo's `engines` field requires `node >=22.0.0`.
- **`npm` on your `PATH`**: the install step runs `npm install -g openclaw@^2026.5`.
- **A provider API key** for whichever model provider you'll configure OpenClaw with (Anthropic, OpenAI, Google, OpenRouter, and others). Ollama needs no key, but it must be running locally.
- No prior OpenClaw install is required; the wizard can install, configure, and start one for you.
</Note>

OpenClaw is a separate project; Clawboo connects to a Gateway you run locally, it does not bundle OpenClaw. The wizard pins the install to `openclaw@^2026.5` deliberately: Clawboo's gateway client advertises connect protocol `minProtocol: 3, maxProtocol: 4`, and the pin keeps a fresh user on a protocol-compatible OpenClaw.

## Steps

### 1. Launch Clawboo

Run the launcher:

```bash
npx clawboo
```

The CLI prints the Clawboo logo, does a quick informational probe of the OpenClaw Gateway port (`localhost:18789`), starts the bundled dashboard server, then opens your browser at the discovered URL.

**Expected result:** your terminal shows `Dashboard started` and `Clawboo opened at http://localhost:18790` (or the next free port in the `18790–18809` range), and the dashboard loads. Because this is a fresh machine, the onboarding wizard appears.

### 2. Click "Get Started"

The first screen is the welcome splash: the Clawboo wordmark, the line "Your AI agents, visible.", and a **Get Started** button.

**Expected result:** clicking **Get Started** advances to the runtime-choice step.

### 3. Choose OpenClaw

The next screen asks **"How do you want your agents to run?"** It shows the **Clawboo Native** card first, then a divider, then secondary cards for OpenClaw, Claude Code, Hermes, and Codex.

Click the **OpenClaw** card.

**Expected result:** the wizard branches to the **System Check** step, the OpenClaw setup flow's entry point. (Picking the native card instead would skip the Gateway entirely; see [Quickstart: native](/getting-started/quickstart-native).)

### 4. Let Clawboo detect your environment

The **System Check** step fetches `GET /api/system/status` on mount and shows an animated three-item checklist: **Node.js**, **OpenClaw**, and **Gateway**, each revealed in sequence:

- **Node.js**: a green check when your version is 22 or newer (a red X with a Download link otherwise).
- **OpenClaw**: green with the detected version when the `openclaw` binary is on your `PATH`; an amber dot reading "Not found" otherwise.
- **Gateway**: green "Running on :18789" when a managed Gateway process is alive or the port probes reachable; amber "Not running" otherwise.

A single **call-to-action** button at the bottom reflects what's missing. On a fresh box it reads **Install OpenClaw**; once OpenClaw is installed but unconfigured it reads **Set Up OpenClaw**; once configured but the Gateway is down it reads **Start Gateway**; when everything is green it reads **Continue** and auto-advances after ~1.5 seconds.

**Expected result:** the checklist resolves, and the CTA tells you the next action. If everything was already green, you skip ahead to the team step (step 8); otherwise click the CTA to proceed through the steps below.

<Tip>
If you already run a Gateway on another machine, click **Connect to remote gateway →** at the bottom of System Check to enter a Gateway URL and token directly instead of installing locally.
</Tip>

### 5. Install OpenClaw

If OpenClaw isn't installed, clicking **Install OpenClaw** opens the **Installing OpenClaw** step, which streams `POST /api/system/install-openclaw`, a Server-Sent Events stream that runs `npm install -g openclaw@^2026.5` and shows live `npm` output in a terminal log.

The stream emits typed events:

| Event `type` | Payload                      | Meaning                                                  |
| ------------ | ---------------------------- | -------------------------------------------------------- |
| `progress`   | `{ step, message }`          | Phase marker                                             |
| `output`     | `{ line }`                   | A line of `npm` output                                   |
| `error`      | `{ code, message }`          | `EACCES`, `SPAWN_THROW`, `SPAWN_ERROR`, or `EXIT_<code>` |
| `complete`   | `{ success: true, version }` | Install finished                                         |

On `complete`, the step shows "Installed! v…" and auto-advances to configuration after ~1 second.

**Expected result:** the terminal log fills with `npm` output, then the step reports the installed version and moves on.

<Warning>
A global `npm install` can fail with `EACCES` ("permission denied"). The stream emits an `error` event with code `EACCES`, and the step shows a **How to fix** panel suggesting a Node version manager (nvm/fnm) or Homebrew. Prefer either of those over `sudo`.
</Warning>

### 6. Configure a provider

The **Set Up OpenClaw** step shows a provider grid: four primary cards (Anthropic, OpenAI, Google, Ollama) plus a "More providers" section (OpenRouter, xAI, Groq, and others). Pick a provider, paste your API key into the **API Key** field (the eye icon toggles visibility), and optionally choose a **Default Model** from the dropdown. Ollama needs no key; selecting it hides the key field.

Clicking **Configure & Start** posts to `POST /api/system/configure-openclaw` with `{ provider, apiKey?, model? }`. The handler:

- writes OpenClaw's `openclaw.json` in **local mode** (`gateway.mode: 'local'`, token auth, agent-to-agent tooling enabled with `tools.sessions.visibility: 'all'`) and a default model under `agents.defaults.model.primary`;
- generates a Gateway auth token and writes it into OpenClaw's `~/.openclaw/.env` as `GATEWAY_AUTH_TOKEN`, alongside your provider key;
- saves Clawboo's own `settings.json` (`gatewayUrl`, `gatewayToken`).

The handler returns `{ ok: true, gatewayUrl }`. The raw token is **never returned in the response body**; it's persisted server-side, and the same-origin proxy injects it on connect.

**Expected result:** the button shows "Configuring…", then the wizard advances to the Gateway-start step.

### 7. Start the Gateway and approve the device

The **Starting Gateway** step posts `POST /api/system/gateway` with `{ "action": "start" }`, an SSE stream that spawns the Gateway detached, polls until the port (`18789`) is reachable (up to 60 seconds), syncs the token, and reconnects Clawboo's server-side agent source. On the `complete` event, the step auto-connects a Gateway client through the same-origin WebSocket proxy.

On OpenClaw **2026.5.x and later**, that first connect **fails with `NOT_PAIRED`**; a new device lands in OpenClaw's pending list and must be approved by a human before it can connect:

```
GatewayResponseError { code: 'NOT_PAIRED', message: 'pairing required: device is not approved yet' }
```

Instead of an error, the step swaps in an **Approve this device** card. Click **Approve this device**. The card hits `POST /api/system/approve-device`, which performs a two-step shell-out against the OpenClaw CLI:

1. `openclaw devices approve --latest` runs in **preview** mode: it prints `Approve this exact request with: openclaw devices approve <UUID>` and exits non-zero. Clawboo regex-extracts the UUID from the captured output.
2. `openclaw devices approve <UUID>` performs the actual approval.

On success, the step automatically retries the original connect with the same URL and token, and the connection completes.

**Expected result:** the mascot pulses while the Gateway starts, the **Approve this device** card appears, and after you click it the status flips to **Connected!** and the wizard advances to the runtime-connect step (which you can **Skip** straight through to the team step on the OpenClaw path).

<Tip>
You can pair from a terminal instead: run `openclaw devices approve --latest` to see the request id, then `openclaw devices approve <requestId>`. The approval card surfaces this manual fallback too.
</Tip>

### 8. Deploy a team

The **Choose your team** step shows a grid of ready-made starter crews (drawn from Clawboo's built-in templates), each with its emoji, agent count, and a few member avatars. Click a team to deploy it (or click **Skip: start with an empty fleet** to land in the dashboard with no team).

The **Deploy** step then creates the team and its agents in order: it `POST /api/teams` to create the team, creates each agent (writing its SOUL.md, IDENTITY.md, TOOLS.md, and an enhanced AGENTS.md with the team roster and collaboration protocol), assigns each agent to the team, sets the team-internal lead when one is detected, and, when any agent has `@mention` routing, enables agent-to-agent coordination in the Gateway config. A row of ghosts lights up as each Boo is created.

**Expected result:** the ghosts light up one by one to "All N Boos ready", and after a brief beat the wizard finishes. You land in the dashboard, connected to the Gateway, directly in your new team's group chat.

## What you should see

The dashboard opens with your team selected and its group chat in view. The sidebar shows the team and its Boos, the Gateway is connected, and your agents are ready to collaborate.

The team space looks like this once you start collaborating:

![Clawboo team space: a team's Ghost Graph on top and group chat below](/images/team-space.png)

## What just happened

The wizard walked the full OpenClaw setup: it detected your environment, installed and configured OpenClaw with your provider key, started the Gateway, and approved this device for pairing. Once the Gateway came up, Clawboo opened two connections to it: a browser-side same-origin proxy connection for the chat/execution stream, and a server-side connection that mirrors the Gateway's agent list into SQLite (the [registry of record](/appendices/glossary), so the fleet survives the Gateway being down). Deploying a team created real OpenClaw agents and wired their routing, so they can delegate to each other over the Gateway.

## Next steps

- [Deploy and watch your first team collaborate](/getting-started/first-team)
- [Tour the dashboard: Atlas, Ghost Graph, and the view modes](/getting-started/dashboard-tour)
- [The OpenClaw runtime in depth: connections, channels, memory scope](/runtimes/openclaw)
- [System API reference: status, install, configure, gateway, device](/reference/rest-api/system)
- [Concept: the agent model and the five runtime classes](/concepts/agent-model)

<Card title="Enjoying Clawboo? Star it on GitHub" icon="star" href="https://github.com/clawboo/clawboo">
  Clawboo is free and open source. A star is the best way to support the project and helps other people find it.
</Card>
