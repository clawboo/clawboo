---
title: 'Run Clawboo without an API key'
sidebarTitle: 'No API key'
description: 'Run your agents on a free local Ollama model or on your ChatGPT plan instead of a pay-per-token API key, and know the limits of each path.'
icon: 'key-round'
keywords:
  [
    'Ollama',
    'local model',
    'ChatGPT subscription',
    'Sign in with ChatGPT',
    'Codex',
    'free',
    'OpenClaw on Ollama',
  ]
---

Clawboo itself is free. What costs money is the AI model your agents use, and an API key bills you for every token. Two paths need no API key: a local model that runs on your own computer through Ollama, and your ChatGPT plan through the Codex runtime. This recipe sets up either one and says what to expect from it.

**What you'll build:** a team that runs on a local Ollama model or on your ChatGPT plan, and optionally an OpenClaw Gateway on the same local model.

**Time:** about 15 minutes, plus the time to download a model for Ollama.

## Choose a path

|                         | Local model (Ollama)                        | ChatGPT plan                                        |
| ----------------------- | ------------------------------------------- | --------------------------------------------------- |
| What you pay            | Nothing. The model runs on your computer.   | Your ChatGPT subscription, within its usage limits. |
| Where your prompts go   | To Ollama on your computer.                 | To OpenAI.                                          |
| Runtime your agents use | Clawboo Native, built into Clawboo.         | Codex, which Clawboo installs for you.              |
| What you need           | Ollama and one model that can use tools.    | A ChatGPT account with a subscription.              |
| Quality                 | Depends on the model your computer can run. | ChatGPT's own models.                               |

## Before you begin

- Clawboo is installed. See [Install Clawboo](/getting-started/installation).
- If you have not finished onboarding yet, you do the connect step during onboarding. If you have, you do it in **Settings**. Both ways are below.

## Set it up

<Tabs>

<Tab title="Local model (Ollama)">

<Steps>

<Step title="Install and start Ollama">

Download Ollama from [ollama.com/download](https://ollama.com/download) and open it. Ollama keeps running in the background. From a terminal, `ollama serve` starts it too.

</Step>

<Step title="Pull a model that can use tools">

```bash
ollama pull llama3.2
```

`llama3.2` is the model Clawboo suggests. Any chat model works if Ollama reports that it can use tools: agents call tools on almost every turn (memory, the board, handing work to teammates). Clawboo's model menus mark the others **(can't use tools)**. Embedding models such as `nomic-embed-text` never appear in those menus, because they cannot answer a chat.

</Step>

<Step title="Connect Ollama to Clawboo">

- **During onboarding:** on **Connect your AI provider**, click **Ollama** (Local · no key needed). Pick your model under **Model** and click **Continue**.
- **After onboarding:** open **Settings** (`Cmd/Ctrl + ,`), then **Runtimes**. Expand **Clawboo Native** (its button reads **Connect** or **Manage**). Under **LLM providers**, find **Ollama** and click **Use**.

You should see onboarding move on to **Add more runtimes**, or, in **Settings**, Ollama listed among the connected providers. To make Ollama the provider new agents use, expand its row and click **Make default**.

</Step>

<Step title="Deploy a team">

In onboarding, **Choose your first team** puts every member on Clawboo Native with your Ollama model. From the **Marketplace**, check that each member's runtime reads **Clawboo Native** in **Customize team**, then click **Deploy team**.

Every agent, the lead and the specialists alike, uses the same Ollama model. One model means your computer does not reload a different one at each hand-off.

</Step>

<Step title="Let team memory search by meaning (optional)">

```bash
ollama pull nomic-embed-text
```

When Ollama on this computer has `nomic-embed-text`, Clawboo's team memory uses it to find facts by meaning, without sending them anywhere. Without it, and with no OpenAI key connected, memory search matches keywords. Clawboo looks for it at `http://localhost:11434` only.

</Step>

</Steps>

To change the model later, open **Settings** > **Runtimes** > **Clawboo Native** > **Manage**, expand the **Ollama** row and pick a **Default model**. Boo Zero switches to it at once, and agents you create afterwards get it. An existing agent keeps its model until you change it on the agent's page.

</Tab>

<Tab title="ChatGPT plan">

<Steps>

<Step title="Sign in with ChatGPT">

- **During onboarding:** on **Connect your AI provider**, click **OpenAI**, then **Sign in with ChatGPT** (marked Recommended). If Codex is not installed yet, click **Install Codex** first. Click **Sign in with ChatGPT**: the ChatGPT sign-in page opens in your browser. Approve it there. When you see "Your team will run on your ChatGPT subscription. No API key needed.", click **Continue**.
- **After onboarding:** open **Settings** (`Cmd/Ctrl + ,`), then **Runtimes**. On the **Codex** row, click **Install** if it shows, then **Sign in**, then **Sign in with ChatGPT**. You can also start from **Settings** > **Providers** > **ChatGPT subscription** > **Connect**.

You should see the **Codex** row read **Connected**.

</Step>

<Step title="Deploy a team on Codex">

In onboarding, **Choose your first team** puts every member on Codex, and the first Codex agent it creates becomes the team's lead and Boo Zero.

From the **Marketplace**, set each member's runtime to **Codex** in **Customize team** before you click **Deploy team**. The menu suggests OpenClaw, or Clawboo Native when no OpenClaw Gateway is connected, and Clawboo Native cannot run without an API key or Ollama. A member's runtime cannot be changed after the deploy.

</Step>

<Step title="Send a first request">

Ask the team for something in **General**. When a task finishes, its detail shows **Codex** as the runtime and a cost marked "est.".

</Step>

</Steps>

Codex runs your account's default model, so there is no model menu for Codex members.

<Warning>

Clawboo runs Codex with its own sandbox and approval prompts turned off. A Codex agent can run commands and change files anywhere your user account can, without asking. Read [What agents can do](/concepts/permissions) before you give it real work.

</Warning>

</Tab>

</Tabs>

## Check that it worked

1. In the team's **General** chat, ask for something small, for example "List three names for a weekly newsletter."
2. Boo Zero replies, or hands the work to a teammate as a task card.
3. Open the finished task in the **Tasks** card. Its detail names the runtime that ran it: **Clawboo Native** for Ollama, **Codex** for your ChatGPT plan.

## Limits to know

### Local models

- **Every agent needs tool use.** A model without it fails with "… can't use tools, and this agent needs them." Pick one Ollama reports as tool-capable.
- **Quality depends on your computer.** A model small enough for a laptop makes more mistakes than a hosted one, most often when it hands work to teammates. If tasks go wrong, try the largest tool-capable model your computer runs comfortably.
- **Costs read free.** A run on a model your own Ollama serves is recorded at $0, shows as "free" on task cards and charges no budget. Ollama's cloud models (a `-cloud` tag) run on ollama.com instead, so Clawboo estimates them at a default rate, marks them "est." and counts them toward budgets. See [Budgets and spend](/using/budgets-and-spend).

### ChatGPT plan

- **One plan, shared limits.** Codex, and OpenClaw or Hermes if you sign them in too, all use your one ChatGPT plan. They share its usage limits with each other and with your own Codex use.
- **Costs show as estimates.** Codex reports tokens but not dollars, so Clawboo estimates a cost and marks it "est.". Your plan is a flat fee, so the estimate is not your bill, but it counts toward budgets like any other cost.
- **Coding agent, full access.** Codex works with your account's permissions and its approval prompts off (see the warning above).

## Run OpenClaw on your local Ollama (optional)

OpenClaw agents can run on the same local model. Do the Ollama path above first, so Clawboo knows you chose Ollama. OpenClaw also needs a Node.js version it accepts: 24.22.1 or a later 24.x, or 26.12.1 or newer.

<Steps>

<Step title="Start the OpenClaw setup">

Open **Settings** > **Runtimes**. On the **OpenClaw** row, click **Set up**, then **Set up OpenClaw**. Clawboo installs OpenClaw if it is missing, points it at your local Ollama, starts the Gateway and connects.

</Step>

<Step title="Approve this device">

When OpenClaw asks, click **Approve this device**.

You should see the **OpenClaw** row read **Connected**.

</Step>

</Steps>

**Set up OpenClaw** reuses the first credential it finds, in this order: a provider API key you connected, OpenClaw's own ChatGPT sign-in, an offer to sign OpenClaw in with ChatGPT (when Codex is signed in), and then your local Ollama. So OpenClaw runs on Ollama only when no API key and no ChatGPT sign-in are connected. For Ollama, Clawboo adds the line `OLLAMA_API_KEY=ollama-local` to `~/.openclaw/.env`. It is a marker OpenClaw needs, not a secret. If OpenClaw's default model is not pulled, the setup stops with the `ollama pull` command and a **Check again** button. An OpenClaw agent whose model is an `ollama/` one is recorded at $0, like Clawboo Native on Ollama.

More on OpenClaw: [OpenClaw](/runtimes/openclaw).

## Variations

| You want                              | Do this                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ollama on another computer            | Start the Clawboo server with `OLLAMA_BASE_URL` set to that Ollama's address, ending in `/v1` (for example `http://192.168.1.20:11434/v1`). Agent runs use it; team memory still looks for its embedding model at `localhost:11434`. |
| Hermes on your ChatGPT plan           | Once Codex is connected, the **Hermes** card in **Settings** > **Runtimes** offers **Use my ChatGPT subscription**. Hermes signs in with a one-time code, which your ChatGPT account must allow under **Settings** > **Security**.   |
| Local and ChatGPT members on one team | Connect both, then pick **Clawboo Native** or **Codex** per member. See [Mix runtimes on one team](/guides/multi-runtime-team).                                                                                                      |
| An API key after all                  | Add one in **Settings** > **Providers**. See [Providers and runtimes](/using/providers-and-runtimes).                                                                                                                                |

## Troubleshooting

<AccordionGroup>

<Accordion title="Ollama is running, but has no chat model yet">

**What it means:** Ollama answered, but it has no model that can hold a chat. Embedding models do not count.

**Fix:** run `ollama pull llama3.2`, then click **Check again**.

</Accordion>

<Accordion title="Ollama doesn't have this model yet, so this run couldn't start">

**What it means:** the agent's model is not pulled on this computer.

**Fix:** run the `ollama pull` command the message shows, or pick a model you have pulled in the agent's model menu on its page.

</Accordion>

<Accordion title="This model can't use tools, and this agent needs them">

**What it means:** the model cannot call tools, and every agent uses tools.

**Fix:** pick a tool-capable model on the agent's page, or pull one with `ollama pull llama3.2`.

</Accordion>

<Accordion title="Ollama isn't answering on this machine">

**What it means:** Clawboo could not reach Ollama at its address (`http://localhost:11434` unless you set `OLLAMA_BASE_URL`).

**Fix:** open Ollama, or run `ollama serve`, then try again. If you don't have it, install it from [ollama.com/download](https://ollama.com/download).

</Accordion>

<Accordion title="Tasks on a ChatGPT-only setup fail as soon as they start">

**What it means:** the members were deployed on Clawboo Native or OpenClaw, which need an API key, Ollama or a Gateway.

**Fix:** delete the team with **Delete with agents** and deploy it again with every member set to **Codex** in **Customize team**.

</Accordion>

<Accordion title="Sign in with ChatGPT does not finish">

**What it means:** the browser sign-in was closed or failed. For Hermes, your ChatGPT account may not allow sign-in with a one-time code.

**Fix:** click **Sign in with ChatGPT** again. For Hermes, turn on device code sign-in under **Settings** > **Security** in ChatGPT, then retry. If the button keeps failing, run the command the card shows in a terminal, then click **Re-check**.

</Accordion>

</AccordionGroup>

## Next steps

- [Run a content or research team](/guides/content-team): put your new setup to work.
- [Providers and runtimes](/using/providers-and-runtimes): manage keys, Ollama and sign-ins in **Settings**.
- [Clawboo Native](/runtimes/native): the runtime your Ollama agents use.
- [Codex](/runtimes/codex): the runtime your ChatGPT plan powers.
- [Budgets and spend](/using/budgets-and-spend): how estimated costs reach budgets.
