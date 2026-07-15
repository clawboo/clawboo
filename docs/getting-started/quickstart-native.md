---
title: 'Quickstart: the native runtime (no Gateway)'
description: Run npx clawboo, connect the built-in native runtime with a provider key, pick and deploy a starter team, and land in it with no OpenClaw Gateway.
---

By the end of this tutorial you'll have a working team, picked from Clawboo's built-in marketplace and running entirely inside Clawboo, with no OpenClaw Gateway, started from a single pasted provider API key.

This is the fastest path to a running team. Clawboo's [native runtime](/appendices/glossary) (`clawboo-native`) is an in-process harness that talks to provider SDKs directly (Anthropic, OpenAI, OpenRouter, or a local Ollama model), so there is nothing extra to install and no Gateway to set up. It is also the default: onboarding drops you straight into connecting it, and other runtimes are opt-in. If you want the OpenClaw Gateway path instead, see [Quickstart: OpenClaw](/getting-started/quickstart-openclaw).

<Note>
These docs describe Clawboo **v0.2.1**, the current release.
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

**Expected result:** clicking **Get Started** advances straight to the native connect step. There is no "pick a runtime" screen; native is the default, and you add other runtimes later.

### 3. Connect Clawboo Native

The next screen is titled **"Connect your AI provider"**; the key you paste here powers the built-in Clawboo Native runtime. Choose your provider from the grid, **Anthropic** (Claude models, the default), **OpenAI** (GPT models), **OpenRouter** (any model, one key), or **Ollama** (local, no key needed), then paste your API key into the **API Key** field. The eye icon toggles key visibility. Picking **Ollama** hides the key field. A **model** dropdown lets you pick the team leader's default model; it starts on the provider's strongest option, and you can fine-tune any agent's model later from its [detail view](/using/agents).

![The provider connect step: provider cards, the API key field, and the leader model picker](/images/onboarding-connect-provider.png)

Optionally, click **Test connection** below the field. Clawboo does a single authenticated `GET` against the provider's models endpoint (Anthropic `/v1/models`, OpenAI `/v1/models`, OpenRouter `/v1/models`, or the Ollama `/api/tags` probe) with an 8-second timeout. The key used for this test is never stored, logged, or echoed back.

**Expected result:** if you tested, you see a "Key works" confirmation in green (or an error like "Invalid API key." in red). Either way the **Continue** button is enabled once a key is present (or Ollama is selected). Clicking it stores the key in Clawboo's encrypted, at-rest vault (under the env-var slot for the chosen provider, never a plaintext file, never returned in any response; Ollama is keyless, so nothing is stored) and advances to the optional runtimes step. No team is created yet.

### 4. Add more runtimes (optional)

The **"Add more runtimes"** step is optional. Here you can connect Claude Code, Codex, Hermes, or an OpenClaw Gateway as peers, or set up OpenClaw through an inline "Set up OpenClaw" detour that returns you to this step when it's done. You can skip it now and add runtimes anytime later from **Settings**, then the **Runtimes** panel.

Click **Skip for now** or, once you've connected anything you want, **Continue**.

**Expected result:** either button advances to team selection. Nothing on this step can strand you; you can deploy a team with or without extra runtimes.

### 5. Pick and deploy a team

The **Team** step opens Clawboo's team marketplace, the same one you'll use later from the dashboard. Browse the starter teams, pick one, then customize it: rename it, choose a color collection, and set each agent's runtime and model. Since you have not connected an OpenClaw Gateway, every agent defaults to **Clawboo Native**, so the whole team deploys Gateway-free. Click **Deploy**.

**Expected result:** Clawboo creates the team and its `clawboo-native` agents (sharing Clawboo's memory), pre-satisfies the team's "Know Your Team" introduction so you land straight in chat, then advances to the "Your team is ready" screen.

### 6. Open your dashboard

The final wizard screen, **"Your team is ready"**, shows your deployed team's roster (with the agent count in the subtitle) and a note that they share one memory.

Click **Open my dashboard**.

**Expected result:** you enter the dashboard in **native mode**, no Gateway, no GatewayClient, and land directly in your new team's group chat.

## What you should see

The dashboard opens with your team selected and its group chat in view. The sidebar shows your team with the Boos you deployed. You're now in a running team that needs no OpenClaw Gateway. The composer is live: type a request and the leader responds, delegating to a teammate when a task needs hands-on work (see [Deploy your first team](/getting-started/first-team) for the full collaboration loop).

The team space looks like this:

![Clawboo team space: a team's Ghost Graph on top and group chat below](/images/team-space.png)

## What just happened

Connecting the native runtime linked your provider key to `clawboo-native`, Clawboo's in-process harness; deploying a team then wrote its agents into SQLite, the [registry of record](/appendices/glossary) for which agents and teams exist. There was no OpenClaw Gateway involved at any point. The leader is wired to coordinate work by delegating tasks onto [the board](/appendices/glossary) (the durable, race-free kanban that is the source of truth for team coordination) rather than doing everything itself, and the team chat runs [server-side](/concepts/delegation-and-orchestration), so a cascade keeps going even if you close the tab.

## Next steps

- [Deploy and watch your first team collaborate](/getting-started/first-team)
- [Tour the dashboard: Atlas, Ghost Graph, and the view modes](/getting-started/dashboard-tour)
- [The native runtime in depth](/runtimes/native)
- [Connect more runtimes (Claude Code, Codex, Hermes)](/runtimes/connecting-runtimes)
- [Concept: the agent model and the five runtime classes](/concepts/agent-model)

<Card title="Enjoying Clawboo? Star it on GitHub" icon="star" href="https://github.com/clawboo/clawboo">
  Clawboo is free and open source. A star is the best way to support the project and helps other people find it.
</Card>
