---
title: 'Quickstart: the OpenClaw Gateway'
description: Install Clawboo, connect the native runtime, then set up OpenClaw in place on the Add more runtimes step, which installs it, starts the Gateway, and pairs this device.
---

By the end of this tutorial you'll have a running OpenClaw Gateway connected to Clawboo, set up from the onboarding wizard's **Add more runtimes** step. Onboarding is native-first, so you connect the native runtime first, then set up OpenClaw inside its row on that same step: Clawboo reuses the credential you already connected, installs OpenClaw if needed, starts the Gateway, and asks you to approve the one-time device pairing. Once OpenClaw is connected you deploy an OpenClaw team from the dashboard.

This is the OpenClaw path. Unlike the other four runtimes, [OpenClaw](/runtimes/openclaw) is a _connected substrate_; Clawboo connects to a running OpenClaw Gateway (a WebSocket server that hosts OpenClaw agents), rather than installing and spawning a CLI per task. If you want a working team with no Gateway at all, the [native runtime quickstart](/getting-started/quickstart-native) is faster: paste one provider key and you're done.

<Note>
These docs describe Clawboo **v0.5.0**, the current release.
</Note>

## Prerequisites

<Note>
- **Node.js**: this page installs OpenClaw, which requires `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`. That is stricter than Clawboo's own `engines` (`node >=22.12.0`), so a Node that runs Clawboo can still be refused by the OpenClaw install. It is not a bare major-version check: Node 22.12 has the right major and is still refused, and Node 23 is excluded outright. The setup does not check your Node version before it installs, so compare `node --version` against that range first.
- **`npm` on your `PATH`**: the install runs `npm install -g openclaw@~2026.9`.
- **A credential OpenClaw can use**: any provider key you connect on the provider step (including one under **More providers**), or a ChatGPT sign-in. If you pick Ollama there, the OpenClaw setup asks for an Anthropic, OpenAI, or OpenRouter key before it continues.
- No prior OpenClaw install is required; the setup installs, configures, and starts one for you.
</Note>

OpenClaw is a separate project; Clawboo connects to a Gateway you run locally, it does not bundle OpenClaw. Clawboo pins the install to `openclaw@~2026.9` deliberately. The pin is not about the connect protocol, which negotiates cleanly across both lines. It holds the OpenClaw **config shape**: 2026.9 moved the agent roster from `agents.list` to `agents.entries` and tightened `config.patch`, and Clawboo writes both.

## Steps

### 1. Install and launch Clawboo

Install Clawboo globally, then run it:

```bash
npm install -g clawboo
clawboo
```

Prefer not to install? `npx clawboo@latest` runs the latest instead. Either way, the CLI prints the Clawboo logo, does a quick informational probe of the OpenClaw Gateway port (`localhost:18789`), starts the bundled dashboard server, then opens your browser at the discovered URL.

**Expected result:** your terminal shows `Dashboard started` and `Clawboo opened at http://localhost:18790` (or the next free port in the `18790–18809` range), and the dashboard loads. Because this is a fresh machine, the onboarding wizard appears.

### 2. Click "Get Started"

The first screen is the welcome splash: the Clawboo wordmark, the line "Your AI agents, visible.", and a **Get Started** button.

**Expected result:** clicking **Get Started** advances to the native connect step. There is no "pick a runtime" screen; native is the default, and OpenClaw is added afterward.

### 3. Connect the native runtime, then open the OpenClaw row

Onboarding is native-first, so you connect the built-in native runtime before adding OpenClaw. On the **Connect your AI provider** step, pick a provider and paste a key (or select **Ollama** for a keyless local model, or keep OpenAI's **Sign in with ChatGPT** method), then click **Continue**. Clawboo stores the credential and advances to the **Add more runtimes** step (you pick and deploy a team in a later step). (The native connect step is covered in full in [Quickstart: native](/getting-started/quickstart-native).)

On **Add more runtimes**, every runtime is a row. Find the **OpenClaw** row ("Run OpenClaw agents on a local Gateway"), click its **Set up** button to expand it, then click **Set up OpenClaw**.

**Expected result:** the row's body turns into a compact **Set up OpenClaw** panel with a **Cancel** button, and the row's footer reads **In setup**. You never leave **Add more runtimes**; steps 4 to 7 below all happen inside this row.

![The OpenClaw setup running on the Add more runtimes step: install output streams in the terminal log while the Gateway starts](/images/openclaw-inline-setup.png)

### 4. Let Clawboo prepare OpenClaw

The panel starts on its own and shows **Preparing OpenClaw…** while it posts `POST /api/system/auto-configure-openclaw`. That call reuses a credential you already connected, so OpenClaw never asks for a key twice. It looks for, in order:

1. a connected provider key: the one from the provider step, or any key in the Providers hub;
2. a ChatGPT-subscription (`openai-codex`) sign-in that OpenClaw already holds.

When it finds one, it writes OpenClaw's configuration without overwriting anything you already set:

- **`~/.openclaw/.env`**: keeps an existing `GATEWAY_AUTH_TOKEN` or generates one and, when the credential is a key, adds it under its variable name (for example `ANTHROPIC_API_KEY`). The key also goes into the `auth-profiles.json` of any OpenClaw agents that already exist.
- **`~/.openclaw/openclaw.json`**: **local mode** (`gateway.mode: 'local'`), plus, only where the field is missing, port `18789`, token auth, a default model under `agents.defaults.model.primary`, and agent-to-agent tooling (`tools.agentToAgent.enabled: true`, `tools.sessions.visibility: 'all'`).
- **Clawboo's `~/.clawboo/settings.json`**: `gatewayUrl` (`ws://localhost:18789`) and `gatewayToken`.

The raw token is **never returned to the browser**; it's persisted server-side, and the same-origin proxy injects it on connect. (`OPENCLAW_STATE_DIR` and `CLAWBOO_HOME` move those two directories.)

**Expected result:** with a credential found, the panel goes straight on to installing OpenClaw or starting the Gateway (step 6). Without one, it stops and asks you for one (step 5).

### 5. Add a key or sign in with ChatGPT, if asked

This step only appears when Preparing finds no credential OpenClaw can use.

**No provider key** (for example, you chose Ollama on the provider step): the panel reads "Connect a provider key for OpenClaw to use." Pick **Anthropic**, **OpenAI**, or **OpenRouter** from the dropdown, paste the key (the eye icon toggles visibility), and click **Connect & set up** or press Enter. Clawboo saves the key to its vault through `POST /api/providers/:id/connect`, where the Providers hub keeps keys, and the setup starts again at Preparing, which now finds it. The setup does not configure OpenClaw on Ollama.

**Signed in with ChatGPT** (Codex is connected, but OpenClaw has no sign-in of its own): each runtime keeps its own ChatGPT sign-in, so OpenClaw needs one too. Signing in needs the `openclaw` binary, so the panel first installs OpenClaw if it's missing (**Installing OpenClaw…**, as in step 6) and confirms with an **OpenClaw installed** chip. Click **Sign in with ChatGPT**: Clawboo runs OpenClaw's own browser sign-in (`openclaw models auth login --provider openai-codex`) on your machine, your browser opens on OpenAI's sign-in page, and there is no code to type. Once the sign-in is saved, the setup runs again by itself. **Re-check** runs it again by hand, and **Use an API key instead** switches to the key prompt above. If the one-click sign-in can't run (on Windows, for example), the panel shows that command to copy into a terminal; run it, then click **Re-check**.

**Expected result:** the panel leaves the prompt and carries on with step 6.

### 6. Install OpenClaw and start the Gateway

If the `openclaw` binary isn't on your `PATH` (the panel checks `GET /api/system/status`), it shows **Installing OpenClaw…** and streams `POST /api/system/install-openclaw`, which runs `npm install -g openclaw@~2026.9`. Live `npm` output scrolls in a terminal log under the label. With OpenClaw already installed, this is skipped.

Next the panel shows **Starting the Gateway…** and streams `POST /api/system/gateway` with `{ "action": "start" }`. A Gateway already answering on port `18789` is used as is. Otherwise Clawboo spawns the Gateway detached (it logs to `~/.clawboo/gateway.log`, which is tailed into the terminal log), polls until the port is reachable (up to 60 seconds), syncs the token, and reconnects Clawboo's server-side agent source. If the Gateway refuses to start until `openclaw doctor --fix` migrates its data, which can happen after an OpenClaw upgrade, Clawboo runs that once and launches again.

**Expected result:** the terminal log fills with `npm` output, then Gateway startup lines, and the panel moves on to connecting.

<Warning>
A global `npm install` can fail with `EACCES` ("permission denied"). The panel stops on an error that suggests `sudo npm install -g openclaw@~2026.9`. Prefer a Node version manager (nvm, fnm) or Homebrew's Node, which install global packages without `sudo`, then click **Retry**.
</Warning>

### 7. Approve the device

With the Gateway up, the panel connects a Gateway client through the same-origin WebSocket proxy. On OpenClaw **2026.5.x and later**, that first connect **fails with `NOT_PAIRED`**; a new device lands in OpenClaw's pending list and must be approved by a human before it can connect:

```
GatewayResponseError { code: 'NOT_PAIRED', message: 'pairing required: device is not approved yet' }
```

Instead of an error, the panel swaps in an **Approve this device** card. Click **Approve this device**. The card hits `POST /api/system/approve-device`, which performs a two-step shell-out against the OpenClaw CLI:

1. `openclaw devices approve --latest` runs in **preview** mode: it prints `Approve this exact request with: openclaw devices approve <UUID>` and exits non-zero. Clawboo regex-extracts the UUID from the captured output.
2. `openclaw devices approve <UUID>` performs the actual approval.

On success the card reads "Approved. Reconnecting…" and the panel retries the connect with the same settings. If the approval fails, the card shows why, and you can click **Approve this device** again.

**Expected result:** the panel shows **OpenClaw connected** with a check mark, collapses about a second later, and the OpenClaw row now reads **Connected**.

<Tip>
You can pair from a terminal instead: run `openclaw devices approve --latest` to see the request id, then `openclaw devices approve <requestId>`. The approval card surfaces this manual fallback too.
</Tip>

**If a phase fails**, the panel replaces its progress with the error and a **Retry** button. Gateway errors say why when OpenClaw does (`Gateway did not start: …`); a Gateway that never binds reports `Gateway did not become reachable within 60s`. **Retry** runs the whole setup again from Preparing: it skips the install once OpenClaw is on your `PATH`, and joins a Gateway that is still booting instead of launching a second one. **Cancel** closes the panel at any point before it connects (an install already running still finishes on the server). The row stays open, so you can start again with its **Set up OpenClaw** button, or set OpenClaw up later from **Settings**, then **Runtimes**, whose OpenClaw row runs this same setup.

### 8. Finish onboarding, then deploy an OpenClaw team

Still on **Add more runtimes**, click **Continue**. The wizard advances to the **Team** step, where you pick a starter team from the marketplace and deploy it. During onboarding every agent defaults to **Clawboo Native** (**Codex** if you signed in with ChatGPT); now that the Gateway is connected you can switch any member to **OpenClaw** from its runtime picker in the customize step.

Then the **Your team is ready** screen shows the roster and a **"Led by ..."** badge for Boo Zero; click **Open my dashboard**. You land in the dashboard connected to the Gateway ("gateway" mode), in your new team's group chat, which opens on a one-time **introduce yourself** screen.

To build a team of OpenClaw agents, open the **Marketplace** (the **+** button, Create a team, at the bottom of the team rail opens its Teams tab), pick a template, and choose **OpenClaw** as the runtime for its members. Deploy creates the team and its agents: it `POST /api/teams` to create the team, writes each agent's SOUL.md, IDENTITY.md, TOOLS.md, and an enhanced AGENTS.md with the team roster and collaboration protocol, assigns each agent to the team, sets the team-internal lead when one is detected, and, when any agent has `@mention` routing, enables agent-to-agent coordination in the Gateway config. See [Deploy your first team](/getting-started/first-team) for the full team-building flow.

**Expected result:** the new team appears in the team rail, connected to the Gateway, and opens directly in its group chat.

## What you should see

The dashboard opens connected to the Gateway, with the team you deployed in view and OpenClaw available as a runtime you can build teams on. Once you deploy an OpenClaw team, its Boos are ready to collaborate.

The team space looks like this once you start collaborating:

![Clawboo team space: a team's Ghost Graph on top and group chat below](/images/team-space.png)

## What just happened

The inline setup on **Add more runtimes** ran the full OpenClaw setup in place: it configured OpenClaw with the credential you had already connected, installed OpenClaw if it was missing, started the Gateway, and approved this device for pairing. Once the Gateway came up, Clawboo opened two connections to it: a browser-side same-origin proxy connection for the chat/execution stream, and a server-side connection that mirrors the Gateway's agent list into SQLite (the [registry of record](/appendices/glossary), so the fleet survives the Gateway being down). Deploying an OpenClaw team from the dashboard then creates real OpenClaw agents and wires their routing, so they can delegate to each other over the Gateway.

## Next steps

- [Deploy and watch your first team collaborate](/getting-started/first-team)
- [Tour the dashboard: the sidebar, the Org chart, and the view modes](/getting-started/dashboard-tour)
- [The OpenClaw runtime in depth: connections, channels, memory scope](/runtimes/openclaw)
- [System API reference: status, install, configure, gateway, device](/reference/rest-api/system)
- [Concept: the agent model and the five runtime classes](/concepts/agent-model)

<Card title="Enjoying Clawboo? Star it on GitHub" icon="star" href="https://github.com/clawboo/clawboo">
  Clawboo is free and open source. A star is the best way to support the project and helps other people find it.
</Card>
