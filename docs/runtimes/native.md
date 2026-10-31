---
title: 'Clawboo Native'
sidebarTitle: 'Clawboo Native'
description: 'The built-in runtime: agents run on a provider key or a local Ollama with nothing to install. Providers, default models, tools, costs and limits.'
keywords:
  [
    'clawboo-native',
    'native runtime',
    'native harness',
    'built-in runtime',
    'ollama',
    'providers',
    'default provider',
    'make default',
    'run_command',
    'delegate',
  ]
---

Clawboo Native is the runtime built into Clawboo. It runs each agent's conversation inside the Clawboo server and calls your AI provider directly, so there is nothing to install and no Gateway to run. Onboarding puts your first team on it.

- **Best for:** most teams. It works with ten cloud providers or a free local model, and it reports cost after every turn.
- **You need:** an API key for one of the providers below, or a local [Ollama](https://ollama.com) with a chat model pulled.

## Set up

Pick one way to give Clawboo Native a model. You can add more providers later.

<Tabs>
<Tab title="Provider key">

<Steps>
<Step title="Get an API key">

Create a key on your provider's site. Most provider rows on the **Providers** page have a **Get a key** link.

</Step>
<Step title="Save it in Clawboo">

Open **Settings > Providers**, click **Connect** on the provider's row, paste the key and click **Save**. Clawboo checks the key with the provider before it saves it. If the check fails, the reason shows under the field, and **Save anyway** stores the key without the check (useful when the provider just can't be reached).

In onboarding, the **Connect your AI provider** step does the same thing.

</Step>
<Step title="Check the runtime">

Open **Settings > Runtimes**. **Clawboo Native** reads **Connected**. Click **Manage**, and your provider is listed under **LLM providers**.

</Step>
</Steps>

</Tab>
<Tab title="Local Ollama (no key)">

<Steps>
<Step title="Pull a model">

Install Ollama, start it (`ollama serve`) and pull a chat model that can use tools:

```bash
ollama pull llama3.2
```

</Step>
<Step title="Turn Ollama on">

Open **Settings > Runtimes** and click **Connect** (or **Manage**) on **Clawboo Native**. On the **Ollama** line ("Local · no key needed"), click **Use**. Clawboo checks that Ollama answers first; **Use anyway** skips the check.

In onboarding, picking the **Ollama** card on the connect step does the same thing.

</Step>
<Step title="Check the model">

Under **LLM providers**, open the **Ollama** row and click **Make default** if Ollama isn't your default yet. Its **Default model** list then shows the chat models your Ollama has pulled.

</Step>
</Steps>

</Tab>
</Tabs>

Saving a key on the **Providers** page also copies it, in plain text, into OpenClaw's `~/.openclaw/.env`, so an OpenClaw Gateway can use it too. See [Connect providers and runtimes](/using/providers-and-runtimes) for where keys are kept.

## Providers and default models

Clawboo Native works with eleven providers: ten with an API key, plus a local Ollama. The **Providers** page also lists MiniMax, NVIDIA, Hugging Face and Venice; their keys reach OpenClaw only.

These are the built-in models for an agent whose model you leave on **Default** when you deploy a team. A team's leader, and a native Boo Zero, get the leader model; everyone else gets the specialist model. On your default provider, the leader runs the model you picked instead (see the next section).

| Provider       | Key name             | Leader model                               | Specialist model                          |
| -------------- | -------------------- | ------------------------------------------ | ----------------------------------------- |
| Anthropic      | `ANTHROPIC_API_KEY`  | `claude-sonnet-5`                          | `claude-haiku-4-5`                        |
| OpenAI         | `OPENAI_API_KEY`     | `gpt-5.4`                                  | `gpt-4o-mini`                             |
| OpenRouter     | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-4.5`               | `openai/gpt-4o-mini`                      |
| Ollama (local) | none                 | A model you have pulled (`llama3.2` first) | Same as the leader                        |
| Google         | `GEMINI_API_KEY`     | `gemini-2.0-flash`                         | `gemini-2.0-flash`                        |
| xAI            | `XAI_API_KEY`        | `grok-2-latest`                            | `grok-2-latest`                           |
| Groq           | `GROQ_API_KEY`       | `llama-3.3-70b-versatile`                  | `llama-3.1-8b-instant`                    |
| Mistral        | `MISTRAL_API_KEY`    | `mistral-large-latest`                     | `mistral-small-latest`                    |
| Together       | `TOGETHER_API_KEY`   | `meta-llama/Llama-3.3-70B-Instruct-Turbo`  | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Cerebras       | `CEREBRAS_API_KEY`   | `llama-3.3-70b`                            | `llama-3.3-70b`                           |
| Moonshot       | `MOONSHOT_API_KEY`   | `moonshot-v1-32k`                          | `moonshot-v1-8k`                          |

The key name is where Clawboo stores the key, and the variable it reads if you export the key in your shell instead. Keys look like `sk-ant-…` (Anthropic), `sk-…` (OpenAI), `sk-or-…` (OpenRouter), `AIza…` (Google), `xai-…` (xAI), `gsk_…` (Groq) and `csk-…` (Cerebras).

### Which provider a new agent gets

When an agent's model is left on **Default**, Clawboo picks its provider in this order:

1. **Your default provider, if it is set up.** That is the provider and model you chose in onboarding, or later with **Make default** (open a provider row under **Settings > Runtimes > Clawboo Native > Manage**). The leader runs the model you picked, and specialists run that provider's specialist model. On Ollama, every agent runs the model you picked.
2. **Otherwise, the first provider that is set up**, in this order: Anthropic, OpenAI, OpenRouter, Ollama, Google, xAI, Groq, Mistral, Together, Cerebras, Moonshot. The agent gets that provider's models from the table above.
3. **With nothing set up**, the agent is created on Anthropic, and its first run reports the missing key.

A key in your shell, or in OpenClaw's `~/.openclaw/.env`, never outranks the default you picked. The deploy dialog names the model each row will get (`Default · <model>`), so you can check before you deploy.

Changing the default model later also moves a native Boo Zero onto it. Other agents keep their model; change one from its own page.

### Local Ollama

- Clawboo reaches Ollama at `http://localhost:11434/v1`. To use another address, set `OLLAMA_BASE_URL` to its OpenAI-compatible base, `/v1` included.
- The model lists show only the chat models your Ollama has pulled. Embedding models such as `nomic-embed-text` are left out, and a model that can't use tools is marked `(can't use tools)`. Agents call tools on almost every turn, so pick one that can.
- An agent created without a model pick gets your default Ollama model if Ollama has it. If not, it gets the most recently pulled model that can use tools. The leader and the specialists get the same model, so Ollama doesn't swap models in and out of memory between turns.
- A default model that Ollama doesn't have, for example one you removed, shows as `<model> (not pulled)`, with its `ollama pull` command and a **Check again** button.
- When Ollama is your only provider, a native Boo Zero runs on it too.
- **Disconnect Ollama** (on the Ollama row) stops Clawboo Native from using Ollama and leaves your keys alone. Agents on an Ollama model can't run until you click **Use** again.

## What Clawboo Native can do

A native agent acts only through the tools Clawboo gives it. Which tools it has depends on where it runs.

| Tool                                    | What it does                                                                                                    | When the agent has it                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Peer room                               | Posts and reads notes in its team's [peer room](/concepts/peer-chat), as itself. The dashboard doesn't show it. | Team chat and team tasks                     |
| Memory                                  | Reads and saves shared [memory](/concepts/memory): its team's in team runs, the global memory in 1:1 chat       | Every run                                    |
| Board                                   | Reads tasks on the board. Clawboo itself makes the board changes.                                               | Every run                                    |
| Connectors                              | Uses the [connectors](/using/connectors) you grant it                                                           | Every run                                    |
| `delegate`                              | Hands a task to a teammate by name. Clawboo turns each call into a board task.                                  | Team chat                                    |
| `read_file`, `write_file`, `list_files` | Reads and writes files inside the run's folder, and nowhere else, not even through a symlink                    | Every run                                    |
| `run_command`                           | Runs one program after you approve it                                                                           | Every run, once you allow it, not on Windows |

The run's folder is the task's own git worktree when the task run has one; see [Worktrees and handoff](/concepts/worktrees-and-handoff). Everywhere else it is the team's folder, `~/.clawboo/workspaces/<team id>`, shared with every teammate: in team chat, on the tasks agents delegate there, on research and review task runs, and in the agent's 1:1 chat. In its 1:1 chat, an agent on no team, such as Boo Zero, uses `~/.clawboo/workspaces/_no-team`. For how this compares with the other runtimes, see [What agents can do](/concepts/permissions).

### Running commands

`run_command` is off for every agent until you allow it. To allow it, open the agent's page, then **Details**, then the **Permissions** tab. Under **Running commands**, switch on **Let this Boo ask to run commands** and confirm with **Allow it to ask**.

- **You approve every command, and nothing is remembered.** Each one raises a card that reads "_agent_ wants to run a command on this computer." with the command and the folder. **Run it** approves it. There is no **Always** option.
- **One program, no shell.** The agent can't use pipes, redirects or shell operators. Programs that run other programs (shells, interpreters, package runners and similar) are refused before you're asked.
- **It runs as you.** The command runs in the run's folder (the team's folder or the task's worktree), under your user account, with network access. Your API keys are not passed to it.
- **Limits per run:** the agent can ask about 10 commands. Each card waits 10 minutes for an answer, a command is stopped after 5 minutes, and output is cut at 64 KiB.
- **A refusal ends it.** If you decline, or nobody answers in time, the agent can't ask again in that run.

<Warning>

The list of refused programs is a speed bump, not a sandbox: some allowed programs can still reach a shell. You reading each card is the safeguard. Check the command and the folder before you click **Run it**.

</Warning>

See [Approvals](/using/approvals) for answering a card, and [Command permissions](/using/command-permissions) for the OpenClaw equivalent.

## Costs

Clawboo Native reports the cost of every turn:

- **Six models have an exact price:** `claude-haiku-4-5`, `claude-sonnet-4-6`, `gpt-4o`, `gpt-4o-mini`, `openai/gpt-4o-mini` and `anthropic/claude-haiku-4.5`. Clawboo records their cost at list price.
- **Every other model is estimated**, including the default leader models `claude-sonnet-5` and `gpt-5.4`. Clawboo prices the turn's token counts from its rate table and records the result as an estimate. A model missing from the table is priced at USD 3 per million input tokens and USD 15 per million output tokens.
- **Local Ollama models are free.** A turn your own Ollama serves is recorded at $0, charges no budget, and its tasks read **free** on the Board. Ollama's cloud models (a `-cloud` tag) run on ollama.com and are estimated like any other unpriced model.

Estimates count toward your budgets. Budgets only warn you unless you set a hard cap. Turns with an exact price are charged as they happen, so a hard cap can stop a native run partway through. Estimated turns are charged when the run ends, in team chat and in 1:1 chat alike. See [Budgets and spend](/using/budgets-and-spend).

## Disconnect

Open **Settings > Runtimes > Clawboo Native > Manage**. You can remove one provider or the whole runtime:

- **Disconnect _Provider_** (for example **Disconnect OpenAI**) on an open provider row removes that provider's key from Clawboo's vault and from OpenClaw's `~/.openclaw/.env`. Your other keys stay.
- **Disconnect Ollama** stops Clawboo Native from using Ollama. Your keys stay.
- **Disconnect**, at the bottom of **Manage**, disconnects Clawboo Native itself.

<Warning>

The bottom **Disconnect** deletes all ten provider keys from Clawboo's vault, not one, and turns Ollama off. Clawboo keeps a single copy of each key, so Claude Code and Hermes lose the keys they shared with Clawboo Native. Until you connect Clawboo Native again (for example with **Use** on a provider row), a key in your shell or in `~/.openclaw/.env` doesn't count for it. To remove one key, use its provider row instead.

</Warning>

## Limits

- **Files only in the run's folder.** File tools work only inside the team's folder, where a 1:1 chat also starts, or the task's worktree.
- **No commands on Windows.** `run_command` is never offered there.
- **16 turns per run.** A run ends after 16 turns (model calls).
- **No ChatGPT plan.** A ChatGPT subscription runs agents on [Codex](/runtimes/codex), not on Clawboo Native.
- **Ten keyed providers.** Keys for MiniMax, NVIDIA, Hugging Face and Venice don't work with Clawboo Native.

## Troubleshooting

<AccordionGroup>
<Accordion title="Clawboo Native has no provider key connected">

The full message is `Clawboo Native has no provider key connected. Open Settings → Runtimes → Clawboo Native to connect a provider.`

**What it means:** the provider this agent runs on has no key Clawboo can use. Clawboo Native can still read **Connected** when another provider has a key. The agent's page shows **No provider key**, or **Disconnected** when no provider is set up at all, next to **Set up in Runtimes →**.

**Fix:** connect a key for that provider on the **Providers** page, or open the agent's page and pick a model from a provider you have connected. An agent on Ollama shows this message after **Disconnect Ollama**; click **Use** on the Ollama line to turn it back on.

</Accordion>
<Accordion title="Ollama doesn't have the model yet">

The chat shows `Ollama doesn't have <model> yet, so this run couldn't start. Pull it with "ollama pull <model>", or pick a model you have pulled in this agent's settings.`

**Fix:** run the `ollama pull` command it gives, or pick a pulled model on the agent's page. After a pull, **Check again** refreshes the model lists.

</Accordion>
<Accordion title="The model can't use tools">

The chat shows `<model> can't use tools, and this agent needs them. Pick a model that can in this agent's settings, or pull one with "ollama pull llama3.2".`

**Fix:** pick a model that isn't marked `(can't use tools)`, or pull one that can.

</Accordion>
<Accordion title="Invalid API key, or Could not reach the provider">

When you save a key, Clawboo checks it with the provider. `Invalid API key.` means the provider refused it: copy the key again from the provider's site. `Provider returned <status>.` is another refusal. `Could not reach <provider>.` (or `Could not reach <provider> (timed out).`) means the check got no answer. If you are sure the key is right, **Save anyway** stores it without the check.

</Accordion>
<Accordion title="Ollama isn't answering on this machine">

`Ollama isn't answering on this machine. Start it (ollama serve) and try again.` appears when you click **Use** on the Ollama line and nothing answers. Start Ollama, or check `OLLAMA_BASE_URL`, then click **Use** again. **Use anyway** turns Ollama on without the check.

</Accordion>
<Accordion title="The agent never offers to run a command">

`run_command` exists only when both of these hold: **Let this Boo ask to run commands** is on for that agent, and the server is not on Windows. A run that started before you switched it on doesn't have it. If the agent says a command was refused, the program was on the refused list, or a command was already declined in that run.

</Accordion>
<Accordion title="Clawboo Native reads Connected though you never connected it">

A key exported in the shell that started Clawboo, or present in OpenClaw's `~/.openclaw/.env`, counts as connected. So does an `OLLAMA_BASE_URL` you set, unless you turned Ollama off. After you disconnect Clawboo Native (see the warning above), only keys you connect again count.

</Accordion>
</AccordionGroup>

## Check it works

<Steps>
<Step title="Check the runtime">

Open **Settings > Runtimes**. **Clawboo Native** reads **Connected**.

</Step>
<Step title="Send a message">

Open an agent that runs on Clawboo Native from the agent column, type a short message in its chat and send it.

</Step>
<Step title="Read the reply">

You should see a reply stream in. If an error appears instead, find it under [Troubleshooting](#troubleshooting).

</Step>
</Steps>

<Accordion title="Under the hood">

- **Where it runs.** Inside the Clawboo server process. Anthropic models go through the Anthropic SDK. Every other provider goes through the OpenAI SDK with that provider's base URL; Ollama's is `OLLAMA_BASE_URL`, default `http://localhost:11434/v1`.
- **A run.** Up to 16 turns; each turn is one model call plus the tool calls it asks for, and each turn reports its own cost.
- **Fallback providers.** An agent's config can list fallback providers (through the API). If a provider fails with an auth, rate-limit, overload or network error before it has produced any output, the next one is tried. A provider that answers is kept for the rest of the conversation.
- **Saved conversations.** Each run's transcript is saved under `~/.clawboo/runtimes/clawboo-native/<agent>/sessions/` (the folder follows `CLAWBOO_HOME`).
- **Context window.** Clawboo Native declares 200,000 tokens for every provider, set high on purpose. A long task run moves to a fresh session late rather than early, and a provider's own context-limit error ends the run cleanly.
- **Agent config.** Each agent's provider, model and tool switches are stored as JSON in the settings table (`native-agent-config:<agentId>`) and checked on every load. A corrupt one falls back to the defaults: Anthropic, `claude-haiku-4-5`, read-only board access.
- **REST.** Connecting, key checks and disconnecting are in the [Runtimes API](/reference/rest-api/runtimes). The command switch is `GET` and `POST /api/agents/:agentId/shell`.

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Clawboo Native compares with the other runtimes
- [Connect providers and runtimes](/using/providers-and-runtimes): keys, where they are stored, and what Disconnect removes
- [What agents can do](/concepts/permissions): what each runtime can touch on your computer
- [Budgets and spend](/using/budgets-and-spend): warn-only and hard-cap budgets, and estimated costs
- [Run Clawboo without an API key](/guides/no-api-key): a full team on a local Ollama
