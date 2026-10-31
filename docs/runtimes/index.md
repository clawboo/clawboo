---
title: 'Choose a runtime'
sidebarTitle: 'Choose a runtime'
description: 'Compare the five runtimes Clawboo runs agents on: what each needs, what it costs, how it treats files, comments and commands, and how to pick.'
icon: 'cpu'
keywords:
  [
    'runtimes overview',
    'runtime',
    'capability matrix',
    'clawboo-native',
    'openclaw',
    'claude-code',
    'codex',
    'hermes',
    'steering',
    'provider',
    'model',
    'gateway',
  ]
---

A runtime is the program that runs an agent's work. It sends the agent's prompts to an AI model, runs the agent's tools, and reports back to Clawboo. Clawboo supports five runtimes. Every agent runs on one of them, and one team can mix them.

Use this page to pick a runtime for a new agent or team, and to see what each one can and can't do. To connect one, see [Connect providers and runtimes](/using/providers-and-runtimes).

## Providers, models, runtimes and the Gateway

Four words come up whenever you connect AI to Clawboo. Each names a different layer.

| Layer                | What it is                                                                                                      | Examples                                              | Where you choose it                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| **Provider**         | The company, or the program on your computer, that runs AI models. A cloud provider bills you for what you use. | Anthropic, OpenAI, OpenRouter, Google, a local Ollama | **Settings > Providers**, a ChatGPT sign-in, or Ollama       |
| **Model**            | The AI model an agent thinks with. Each provider offers several.                                                | `claude-sonnet-5`, `gpt-5.4`, `llama3.2`              | Per agent. Codex and Claude Code use their own default model |
| **Runtime**          | The program that runs the agent: its turns, its tools, its files.                                               | Clawboo Native, OpenClaw, Claude Code, Codex, Hermes  | Per agent, when you create it                                |
| **OpenClaw Gateway** | OpenClaw's own server, which hosts OpenClaw agents. Only the OpenClaw runtime uses it.                          | `ws://localhost:18789`                                | **Settings > Runtimes > OpenClaw**                           |

So one agent might run on Clawboo Native with the model `llama3.2` from your local Ollama, while its teammate runs on Claude Code with your Anthropic key. One key can serve several runtimes: an Anthropic key works for Clawboo Native, Claude Code and Hermes.

## Compare the runtimes

|                                   | Clawboo Native                               | OpenClaw                                                    | Claude Code                                   | Codex                       | Hermes                                                                            |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| **Best for**                      | Most teams; nothing to install               | OpenClaw users, messaging channels                          | Coding with Anthropic's agent                 | Teams on a ChatGPT plan     | An open-source agent that keeps its own skills                                    |
| **You need**                      | A provider key, or a local Ollama            | A key, a ChatGPT sign-in or Ollama, and a supported Node.js | An Anthropic API key and the Claude Agent SDK | A ChatGPT sign-in           | An OpenRouter, Anthropic or OpenAI key, or a ChatGPT sign-in; Python 3.11 to 3.13 |
| **Installed by**                  | Built in                                     | Clawboo (**Set up OpenClaw**)                               | Clawboo (**Install**)                         | Clawboo (**Install**)       | Clawboo (**Install**)                                                             |
| **Cost you see**                  | Exact for six models, estimated for the rest | Estimated                                                   | Reported by Claude Code                       | Estimated from token counts | Estimated from text length                                                        |
| **Shared memory**                 | Its team's                                   | Global only                                                 | Its team's                                    | Its team's                  | Its team's                                                                        |
| **Own git worktree for a task**   | Task runs on a repository                    | Never                                                       | Task runs on a repository                     | Task runs on a repository   | Task runs on a repository                                                         |
| **A comment on a running task**   | Read before its next step                    | Read before its next step                                   | Read before its next step                     | Read before its next step   | The run pauses, reads it, then resumes                                            |
| **Agent files it reads**          | `SOUL.md`                                    | `SOUL.md`, `IDENTITY.md`, `AGENTS.md`                       | `SOUL.md`                                     | `SOUL.md`                   | `SOUL.md`                                                                         |
| **Asks before running a command** | Every time, if you turn commands on          | Per its Gateway policy                                      | No                                            | No                          | No                                                                                |

What the rows mean:

- **Cost.** Estimates count toward your budgets the same way real costs do. A model your own Ollama serves costs nothing, on Clawboo Native or OpenClaw, so its runs are recorded at $0 and read **free**. [Budgets and spend](/using/budgets-and-spend) explains how each runtime's spend is worked out.
- **Worktrees.** A worktree is a separate checkout of a git repository for one task. No runtime gets one in team chat. Only a task run that names a repository does: one started through the REST API, or an agent Routine whose template names a repository. See [Worktrees and handoff](/concepts/worktrees-and-handoff).
- **Agent files.** Clawboo Native uses `SOUL.md` as the agent's instructions; Claude Code, Codex and Hermes get it as a persona at the top of each prompt. On every runtime, `AGENTS.md` also draws the agent's links on the team graph. OpenClaw shows a `TOOLS.md` tab, but OpenClaw 2026.9 and later doesn't load that file. See [Agents](/using/agents).
- **Commands.** A new OpenClaw agent asks before running a command it hasn't been allowed (**Ask for Unknown**). See [OpenClaw](/runtimes/openclaw#what-a-new-boo-is-allowed-to-run).

<Warning>

Claude Code, Codex and Hermes run with their own sandboxes and approval prompts turned off. Nothing asks before they run a command or change a file, and they can read and change any file your user account can. A per-task worktree keeps their edits apart from your checkout, but it is not a sandbox. Read [What agents can do](/concepts/permissions) before you point them at work you care about.

</Warning>

## How to pick

- **Start with Clawboo Native.** It is built in, so there is nothing to install. Connect one provider key, or a local Ollama to run with no key at all. Onboarding sets it up first. See [Clawboo Native](/runtimes/native).
- **No API key, but a ChatGPT plan?** Choose **Sign in with ChatGPT** in onboarding. Your team then runs on [Codex](/runtimes/codex) and uses your plan instead of a per-token bill. See [Run Clawboo without an API key](/guides/no-api-key).
- **Coding work in a repository?** [Claude Code](/runtimes/claude-code) and [Codex](/runtimes/codex) bring their own coding tools. Read the warning above first.
- **Already use OpenClaw, or want its channels?** [OpenClaw](/runtimes/openclaw) agents keep their messaging channels and their own cron jobs on the Gateway, and join your teams in Clawboo.
- **Want an agent that builds up skills over time?** [Hermes](/runtimes/hermes) keeps a home for each agent, where its skills and memory carry over between runs.
- **Mix them.** When you deploy a team, each member has its own runtime picker in **Customize team**, and Boo Zero leads them all. An agent keeps the runtime it was created on, so choose before you deploy. To move work to another runtime, create a new agent there.

## Steering a running task

Steering means getting a message to an agent while it is still working on a task. Open the task in the board's task drawer, a team chat's **Tasks** card, or the agent's **Tasks & Routines** card. Type your comment and click **Send**. The line beside **Send** tells you what will happen for that task, and once you send, a note under your comment says where it went.

Unless the task is finished, your comment goes into the agent's mailbox, which every run reads when it starts. If a run is working on the task right now, Clawboo also passes the comment into that run:

| Runtime        | What happens to a comment on a running task                                                                                               | The line beside **Send** in the **Tasks** card |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Clawboo Native | Read at the start of its next turn. A run that was about to finish takes one more turn to read it.                                        | "… gets this now, before its next step."       |
| OpenClaw       | Joins the running turn at its next step, without stopping a tool that is running.                                                         | "… gets this now, before its next step."       |
| Claude Code    | Joins the running turn at its next step.                                                                                                  | "… gets this now, before its next step."       |
| Codex          | Joins the running turn at its next step.                                                                                                  | "… gets this now, before its next step."       |
| Hermes         | Clawboo stops the run and resumes the same session with your comment. A tool call in progress at that moment is lost; the run carries on. | "… pauses to read this, then carries on."      |

If the comment can't get into the run (the run ended a moment earlier, or the runtime refused it), nothing is lost: the agent reads it from its mailbox at its next run, and the note under the comment says so. When it does land, the mailbox copy is marked as delivered, so the agent doesn't read it twice. A comment on a task that is not running behaves by the task's status: a task that waits on you, or waits in **To do**, starts again for it, and a finished task does not get it at all. Each case is in [Steer a running task](/using/board#steer-a-running-task).

<Accordion title="Under the hood: how each runtime takes a comment">

A person's comment is posted with `POST /api/board/:taskId/comments` and `authorType: 'user'`, and the answer's `delivery` field says where it went (see the [Board API](/reference/rest-api/board)). Each runtime declares how it takes input mid-run in its `steering` capability: `live` (Clawboo Native, OpenClaw, Claude Code and Codex) or `interrupt-resume` (Hermes).

- **Clawboo Native** queues the comment into the conversation as a user message for its next turn.
- **OpenClaw** gets it through `chat.send` with `queueMode: 'steer'` over the server's own Gateway connection. If the run ends with the steer still unread, Clawboo cancels it (`chat.abort`) and the comment waits in the mailbox.
- **Claude Code** gets a user message pushed into the SDK's streaming input.
- **Codex** gets `turn/steer` on the app-server's in-progress turn.
- **Hermes** has no way in once a run starts, so Clawboo stops `hermes chat` and resumes the same session with the comment. The orchestrator sees one run that carries on, so the task stays in progress with the same agent.

Small team notices, such as "a task you delegated just finished", use the same channel but never keep a finishing run going and never stop a run.

</Accordion>

## Connect a runtime

Open **Settings** (Cmd/Ctrl + ,) and choose **Runtimes** under **Workspace**. Each runtime has a row with its status (**Not installed**, **Needs key**, **Needs login** or **Connected**) and one button: **Install**, **Connect**, **Sign in** (Codex) or **Manage** once it is connected. OpenClaw's row offers **Set up**, or **Reconnect** when its Gateway is offline.

![The Runtimes panel in Settings, listing OpenClaw, Codex, Claude Code, Hermes and Clawboo Native with their status and buttons](/images/runtimes-panel.png)

The full walkthrough, including what **Disconnect** removes, is in [Connect providers and runtimes](/using/providers-and-runtimes).

<Accordion title="Under the hood: runtime ids and the REST API">

The runtime ids are `clawboo-native`, `openclaw`, `claude-code`, `codex` and `hermes`. The `/api/runtimes` routes cover the four runtimes other than OpenClaw, so `/api/runtimes/openclaw/...` answers `404`. OpenClaw is set up through `/api/system/*` and runs over the Gateway connection. See the [Runtimes API](/reference/rest-api/runtimes) and the [System API](/reference/rest-api/system).

Each runtime's adapter declares its capabilities (streaming, MCP, worktrees, steering, its runtime class and its home directory). The full matrix is in [The runtime adapter](/internals/runtime-adapter).

</Accordion>

## Related

- [Clawboo Native](/runtimes/native): the built-in runtime, its providers and local Ollama
- [OpenClaw](/runtimes/openclaw): set up the Gateway, and what Clawboo runs and writes there
- [Connect providers and runtimes](/using/providers-and-runtimes): install, connect, sign in and disconnect
- [What agents can do](/concepts/permissions): each runtime's access to your files, commands and network
- [Budgets and spend](/using/budgets-and-spend): how each runtime's cost reaches your budgets
