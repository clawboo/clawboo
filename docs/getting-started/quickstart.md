---
title: 'Quickstart'
description: 'Start Clawboo, connect an AI provider with an API key, a ChatGPT sign-in or Ollama, deploy a ready-made team and give it its first job.'
icon: 'play'
keywords:
  [
    'quickstart-native',
    'getting started',
    'onboarding',
    'setup wizard',
    'first run',
    'API key',
    'ChatGPT',
    'Ollama',
  ]
---

In this quickstart you start Clawboo, connect one AI provider, deploy a ready-made team and give it its first job. After the first command, everything happens in your browser.

## Before you begin

- **Node.js 22.12 or newer.** Run `node --version` to check. [Install](/getting-started/installation) covers Node and the other ways to run Clawboo.
- **One way to reach an AI model:**
  - an API key from OpenAI, Anthropic, OpenRouter, Google, xAI, Groq, Mistral, Together, Cerebras or Moonshot,
  - a ChatGPT subscription, or
  - [Ollama](https://ollama.com) running on this computer with a chat model pulled.
- **No Clawboo account.** Clawboo is free; the provider you connect bills the model usage.

## Steps

<Steps>

<Step title="Start Clawboo">

Run this in a terminal:

```bash
npx clawboo@latest
```

Clawboo starts a local server and opens your browser. Prefer a lasting `clawboo` command? Install it globally instead; see [Install](/getting-started/installation).

**You should see** the welcome screen, "Your AI agents, visible.", with a **Get Started** button. Click it.

</Step>

<Step title="Connect your AI provider">

The **Connect your AI provider** screen sets up the AI your team runs on. Pick one path:

<Tabs>

<Tab title="API key">

1. Click **OpenAI**, **Anthropic** or **OpenRouter**, or open **More providers** for Google, xAI, Groq, Mistral, Together, Cerebras or Moonshot. For OpenAI, also click the **API key** card: the screen starts on **Sign in with ChatGPT**.
2. Paste your key into **API Key**. No key yet? **Get a key** opens the provider's key page.
3. Optional: choose the **Model** for your team's lead. Teammates you add default to a faster, cheaper model.
4. Click **Continue**. Clawboo checks the key with the provider (**Verifying…**), then saves it in its encrypted vault on your computer (**Connecting…**).

![The Connect your AI provider screen with OpenRouter selected: the provider cards, the API key field and the model picker for the team's lead](/images/onboarding-connect-provider.png)

</Tab>

<Tab title="Sign in with ChatGPT">

1. Keep **OpenAI** and **Sign in with ChatGPT** selected. Both are selected when the screen opens.
2. If the panel asks you to install the Codex CLI first, click **Install Codex**.
3. Click **Sign in with ChatGPT** and finish signing in on the page that opens in your browser. Already signed in to Codex? Click **Already signed in? Re-check**.
4. When the panel says your team will run on your ChatGPT subscription, click **Continue**.

Your team runs on Codex, with no API key. This path has no model picker.

</Tab>

<Tab title="Ollama">

1. Make sure Ollama is running and has a chat model. If it has none, run `ollama pull llama3.2`.
2. Click **Ollama**.
3. Choose a **Model** from the ones your Ollama has pulled. It runs every agent on the team, the lead and the specialists alike. Skip models marked "(can't use tools)": agents use tools on most turns.
4. Click **Continue**.

No key is needed, and the model runs on your computer.

</Tab>

</Tabs>

**You should see** the **Add more runtimes** screen. If a check fails, the reason appears on the screen instead; see [If something goes wrong](#if-something-goes-wrong).

</Step>

<Step title="Skip the extra runtimes">

**Add more runtimes** lists Codex, Claude Code, Hermes and OpenClaw. Connecting them is optional, and you can do it later from **Settings → Runtimes**. Click **Continue**.

If you want them later: Claude Code also needs the Claude Agent SDK installed with Clawboo (see [Install](/getting-started/installation)), and **Set up OpenClaw** installs and starts a local OpenClaw Gateway for you (see [OpenClaw](/runtimes/openclaw)).

**You should see** **Choose your first team**.

</Step>

<Step title="Deploy a team">

The **Create a team** window opens by itself. If you close it, **Browse teams** brings it back.

1. Find a team that fits your work, such as a marketing or research team, and click **Deploy** on its card. **Details** shows who is on it first.
2. In **Customize team**, change the name, badge or colors if you like. Every teammate runs on what you connected in step 2 unless you pick another runtime or model for it here.
3. Click **Deploy team**.

**You should see** a progress count while each agent is created, then **Team deployed!**, then **Your team is ready** with your agents and a "Led by" badge naming Boo Zero, the leader that coordinates the team. On the ChatGPT path, one of the team's own agents takes the Boo Zero role.

</Step>

<Step title="Introduce yourself">

Click **Open my dashboard**. Your team's chat, **General**, opens on a one-time introduction screen. Write a line about who you are and what you're working on (at least 5 characters), then click **Continue to Team Space**. Clawboo saves it to the team's context.

**You should see** the team chat, with your introduction and a short acknowledgement from Boo Zero. The first time, a tour may offer to show you around; **Skip tour** closes it.

</Step>

<Step title="Give your team its first job">

Paste this into the message box at the bottom, or write your own request, and press Enter:

```text
Plan a launch for our new budgeting app: write a short announcement, draft three social posts, and list five questions customers will ask first.
```

**You should see** task cards appear in the chat as Boo Zero hands the parts to teammates. Each card moves from **Queued** to **Working** to **Done**, and the **Tasks** card beside the chat lists the same tasks. When the teammates finish, Boo Zero posts one summary of what the team produced.

A quick question gets a direct answer instead of tasks. If Boo Zero answers a request with several parts by itself, ask it to hand the parts to the team.

</Step>

</Steps>

## What you should see

Your team's chat on the left, with the **Team graph** and **Tasks** cards on the right. Task cards in the chat show who is working on what, and each one opens on the [Board](/using/board).

![A team chat in Clawboo: teammates' updates and two task cards marked Working on the left, and on the right the Team graph card, with Boo Zero above the team lead and four specialists, and the Tasks card, with one task that needs you and five in progress](/images/team-space.png)

Every message uses your provider's tokens, and a team's hand-offs add model runs of their own. [Budgets and spend](/using/budgets-and-spend) shows how to watch spend and set a limit.

## If something goes wrong

<AccordionGroup>

<Accordion title="Invalid API key.">

The provider rejected the key. Copy it again from the provider's key page, check that you picked the matching provider, and click **Continue** again.

</Accordion>

<Accordion title="Could not reach the provider">

The message reads like "Could not reach openai." This computer could not reach the provider within 8 seconds, often because of a proxy, a firewall or no network. Fix the connection and try again. If you are sure the key is right, **Continue anyway** saves it without the check.

</Accordion>

<Accordion title="Ollama isn't answering.">

Start Ollama (open the Ollama app, or run `ollama serve`), then click **Continue** again. Don't have Ollama? The screen links to its download.

</Accordion>

<Accordion title="Ollama is running, but has no chat model yet.">

Run `ollama pull llama3.2`, then click **Check again**. Embedding-only models can't run agents. If the screen says Ollama doesn't have the model you picked, run the `ollama pull` command it shows, then click **Check again**.

</Accordion>

<Accordion title="Install Codex fails">

The panel shows the install output and the reason. A permission error means npm can't write to its global folder: run the `sudo` command the message suggests in a terminal yourself. Then click the **API key** card and **Sign in with ChatGPT** again, so the panel checks for Codex once more.

</Accordion>

<Accordion title="The browser didn't open">

Open the address the terminal printed after "Clawboo opened at", usually `http://localhost:18790`.

</Accordion>

<Accordion title="The team doesn't answer">

Look for an error message in the chat first; it usually names the problem. Then check that your provider is still connected: a key or your ChatGPT subscription in **Settings → Providers**, or Ollama (which must be running) on **Clawboo Native** in **Settings → Runtimes**. Also look in **Needs you** on the Board for work waiting on you. [Troubleshooting](/help/troubleshooting) covers more cases.

</Accordion>

</AccordionGroup>

## Next steps

- [Work with your first team](/getting-started/first-team): find the results, steer a task and stop work.
- [Tour the dashboard](/getting-started/dashboard-tour): the sidebar, Settings and the other views.
- [Providers and runtimes](/using/providers-and-runtimes): add more keys, or Claude Code, Codex, Hermes and OpenClaw teammates.
- [Run Clawboo without an API key](/guides/no-api-key): Ollama and ChatGPT sign-in in more depth.
- [Budgets and spend](/using/budgets-and-spend): watch what your team spends.
