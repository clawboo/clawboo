---
title: Quickstart: the native runtime (no Gateway)
description: Run npx clawboo, choose the native runtime, paste a provider key, and land in a working two-agent team with no OpenClaw Gateway.
---

By the end of this tutorial you'll have a working two-agent team (a leader and a specialist) running entirely inside Clawboo, with no OpenClaw Gateway, started from a single pasted provider API key.

This is the fastest path to a running team. Clawboo's [native runtime](/appendices/glossary) (`clawboo-native`) is an in-process harness that talks to provider SDKs directly (Anthropic, OpenAI, OpenRouter, or a local Ollama model), so there is nothing extra to install and no Gateway to set up. If you want the OpenClaw Gateway path instead, see [Quickstart: OpenClaw](/getting-started/quickstart-openclaw).

<Note>
These docs describe Clawboo **v0.2.0**, the current release.
</Note>

## Prerequisites

<Note>
- **Node.js 22 or newer**: Clawboo's `engines` field requires `node >=22.0.0`.
- **A provider API key** for one of: Anthropic (`sk-ant-…`), OpenAI (`sk-…`), or OpenRouter (`sk-or-…`). Or a running local Ollama, in which case no key is needed.
- No OpenClaw, no Gateway, no global install required.
</Note>

## Steps

### 1. Launch Clawboo

Run the launcher:

```bash
npx clawboo
```

The CLI prints the Clawboo logo, does a quick informational probe of the OpenClaw Gateway port (`localhost:18789`), starts the bundled dashboard server, then opens your browser at the discovered URL.

**Expected result:** your terminal shows `Dashboard started` and `Clawboo opened at http://localhost:18790` (or the next free port in the `18790–18809` range), and the dashboard loads in your browser. Because this is a fresh machine, the onboarding wizard appears.

### 2. Click "Get Started"

The first screen is the welcome splash: the Clawboo wordmark, the line "Your AI agents, visible.", and a **Get Started** button.

**Expected result:** clicking **Get Started** advances to the runtime-choice step.

### 3. Choose the native runtime

The next screen asks **"How do you want your agents to run?"** It shows the **Clawboo Native** card first and prominently (marked recommended, with the copy "Paste an API key and your team is ready in ~60 seconds"), then a divider reading "Or bring your own runtime", then secondary cards for OpenClaw, Claude Code, Hermes, and Codex.

Click the **Clawboo Native** card.

**Expected result:** the wizard advances to the native connect step. (Picking any other card branches to a different setup flow: OpenClaw goes to Gateway detection, the coding-agent runtimes go to a connect step.)

### 4. Pick a provider and paste your key

The connect step is titled **"Connect Clawboo Native"**. Choose your provider with the pills at the top: **Anthropic** (the default), **OpenAI**, or **OpenRouter**, then paste your API key into the **API Key** field. The eye icon toggles key visibility.

If you'd rather use a local model, click **"Use a local model with Ollama, no key needed"**; the key field disappears.

Optionally, click **Test connection**. Clawboo does a single authenticated `GET` against the provider's models endpoint (Anthropic `/v1/models`, OpenAI `/v1/models`, OpenRouter `/v1/models`, or the Ollama `/api/tags` probe) with an 8-second timeout. The key used for this test is never stored, logged, or echoed back.

**Expected result:** if you tested, you see **"Key works"** in green (or an error like "Invalid API key." in red). Either way the **Create my team** button is enabled once a key is present (or Ollama is selected).

### 5. Create the team

Click **Create my team**.

Two things happen in order:

1. **Your key is stored.** Clawboo writes the key into its encrypted, at-rest vault under the env-var slot for the chosen provider, never to a plaintext file, never returned in any response. For Ollama (keyless) there is nothing to store.
2. **A starter team is seeded.** Clawboo creates a team named "My First Team" with two `clawboo-native` agents: a **Team Lead** (configured to coordinate by delegating through the durable board) and a **Coder** specialist. Both agents share Clawboo's memory; the leader uses a capable model (e.g. `claude-sonnet-4-6` on Anthropic) and the specialist a cheaper one (e.g. `claude-haiku-4-5`). The team's "Know Your Team" introduction flow is pre-satisfied so you land straight in chat.

**Expected result:** the button shows "Setting up…", then the wizard advances to the "Your team is ready" screen.

### 6. Open your dashboard

The final wizard screen, **"Your team is ready"**, shows your two seeded agents, a note that they share one memory, and a note that you can add other runtimes (Claude Code, Codex, Hermes, OpenClaw) as peers later.

Click **Open my dashboard**.

**Expected result:** you enter the dashboard in **native mode**, no Gateway, no GatewayClient, and land directly in your new team's group chat.

## What you should see

The dashboard opens with your team selected and its group chat in view. The sidebar shows "My First Team" with its two Boos (Team Lead and Coder). You're now in a running team that needs no OpenClaw Gateway.

<Note>
Native group-chat messaging is still being wired up, so a native-only team's chat composer is currently read-only. To drive a live delegation right now, add an OpenClaw runtime from the Runtimes panel (see [Deploy your first team](/getting-started/first-team)). The team, the board, shared memory, and the capability inventory are all fully live.
</Note>

The seeded team space looks like this once you start collaborating:

![Clawboo team space: a team's Ghost Graph on top and group chat below](/images/team-space.png)

## What just happened

Choosing the native runtime connected your provider key to `clawboo-native`, Clawboo's in-process harness, and seeded a two-agent team into SQLite, the [registry of record](/appendices/glossary) for which agents and teams exist. There was no OpenClaw Gateway involved at any point. The leader is wired to coordinate work by delegating tasks onto [the board](/appendices/glossary) (the durable, race-free kanban that is the source of truth for team coordination) rather than doing everything itself.

## Next steps

- [Deploy and watch your first team collaborate](/getting-started/first-team)
- [Tour the dashboard: Atlas, Ghost Graph, and the view modes](/getting-started/dashboard-tour)
- [The native runtime in depth](/runtimes/native)
- [Connect more runtimes (Claude Code, Codex, Hermes)](/runtimes/connecting-runtimes)
- [Concept: the agent model and the five runtime classes](/concepts/agent-model)
