---
title: 'Mix runtimes on one team'
sidebarTitle: 'Mixed-runtime team'
description: 'Give each member of a team its own runtime in the Customize team step, and learn what each runtime brings and how team memory differs between them.'
icon: 'layers'
keywords:
  [
    'multi-runtime team',
    'build a multi-runtime team',
    'mixed runtimes',
    'Claude Code',
    'Codex',
    'Hermes',
    'OpenClaw',
    'Clawboo Native',
  ]
---

Every agent on a team has its own runtime, the engine that does its thinking and acting. One team can mix them: a Claude Code agent fixes a bug, a Codex agent reviews the fix, and a Clawboo Native agent writes the changelog, while Boo Zero leads all three. Use this recipe when two or more runtimes are connected and you want each member on the one that suits its job.

**What you'll build:** the built-in **Dev Team** (Bug Fixer Boo, Code Reviewer Boo and Doc Writer Boo) with each member on a different runtime.

**Time:** about 15 minutes, plus the time to install any runtime you don't have yet.

## Before you begin

Clawboo is installed and onboarding is done. At least two runtimes must read **Connected** in **Settings** > **Runtimes**. Each one needs:

| Runtime        | What it needs                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clawboo Native | Built in. An API key from a supported provider, or a local Ollama model.                                                                         |
| OpenClaw       | A local OpenClaw Gateway. **Set up OpenClaw** installs and starts one for you.                                                                   |
| Claude Code    | The `claude` CLI, which Clawboo installs, and an Anthropic API key. A global npm install of Clawboo also needs `@anthropic-ai/claude-agent-sdk`. |
| Codex          | The `codex` CLI, which Clawboo installs, and **Sign in with ChatGPT**.                                                                           |
| Hermes         | Python 3.11 to 3.13 (Clawboo installs Hermes with pipx or pip), plus an OpenRouter, Anthropic or OpenAI key, or a ChatGPT sign-in.               |

For the click path per runtime, see [Providers and runtimes](/using/providers-and-runtimes).

## Steps

<Steps>

<Step title="Connect the runtimes you want">

Open **Settings** (`Cmd/Ctrl + ,`) and click **Runtimes** under **Workspace**. On each runtime's row, use its button: **Install**, **Connect**, **Sign in**, or **Set up** for OpenClaw.

You should see two or more rows read **Connected**. Claude Code reads **Needs key** until an Anthropic API key is connected; a signed-in `claude` CLI on its own does not count.

</Step>

<Step title="Start the deploy">

In the sidebar, click **Marketplace**. On the **Teams** tab, find **Dev Team** and click **Deploy**. **Customize team** opens.

</Step>

<Step title="Pick a runtime for each member">

Under **Teammate colors**, each member's row has a runtime menu with **Clawboo Native**, **OpenClaw**, **Claude Code**, **Codex** and **Hermes**. For example:

- **Bug Fixer Boo**: Claude Code
- **Code Reviewer Boo**: Codex
- **Doc Writer Boo**: Clawboo Native

A runtime that is not connected shows **Connect →** in the menu. Choosing it closes this dialog and opens **Settings** > **Runtimes** (for OpenClaw, its setup), so connect first and then deploy. Clawboo Native, OpenClaw and Hermes members also get a model menu. Claude Code and Codex members run on their own default model.

</Step>

<Step title="Deploy the team">

Click **Deploy team**.

You should see **Team deployed!**, and then the team's **General** chat opens. A member keeps the runtime it was deployed on; the dashboard cannot change it later.

</Step>

<Step title="Meet the team and hand it work">

On the **Meet your team** card, click **Get Started**, introduce yourself, and click **Continue to Team Space**. Then ask for work that needs each member, for example:

```text
In ~/code/my-app, fix the failing date test, have the fix reviewed, and write a two-line changelog entry.
```

Boo Zero splits the request into tasks. Each task runs on its teammate's own runtime, and all of them land on the same board and in the same **Tasks** card.

<Warning>

In team chat, Claude Code, Codex and Hermes run with their own approval prompts turned off. They start in the team's folder (`~/.clawboo/workspaces/<team id>`), and can still read and change any file your user account can. There is no isolated checkout on this path. Point them only at work you have committed or backed up, and read [What agents can do](/concepts/permissions). For a separate git checkout per task, see [Hand a task from one runtime to another](/guides/cross-runtime-handoff).

</Warning>

</Step>

</Steps>

## Check that it worked

- On the **Team graph** card beside the chat, each Boo carries a small badge for its runtime.
- In the **Tasks** card, a finished task's detail names the runtime that ran it.
- The tasks of all three members appear on the same **Board**.

## What each runtime brings

| Runtime        | Good for                                      | Tools of its own                                                     | A comment on a running task          | Spend shown                                 |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| Clawboo Native | Writing, planning, coordinating               | None in team chat beyond memory, the board, hand-offs and connectors | Reaches it before its next step      | Exact for a few models, otherwise estimated |
| OpenClaw       | Agents that use your OpenClaw setup           | Whatever your Gateway gives its agents                               | Reaches it before its next step      | Estimated from text length                  |
| Claude Code    | Code changes                                  | Commands, file edits and more, with prompts off                      | Reaches it before its next step      | Reported by Claude Code                     |
| Codex          | Code changes on a ChatGPT plan                | Commands and file edits, with its sandbox off                        | Reaches it before its next step      | Estimated from tokens                       |
| Hermes         | A helper that grows its own memory and skills | Its own tools, every call approved automatically                     | It pauses, reads it, then carries on | Estimated in team chat                      |

The [runtime overview](/runtimes/index) compares them in full, and [Budgets and spend](/using/budgets-and-spend) explains estimated costs.

## How memory differs

Clawboo keeps one shared memory, and every team member uses it through memory tools. What a member sees depends on its runtime:

| Runtime        | Clawboo's team memory                                                                                  | Memory of its own                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Clawboo Native | Reads the team's, its own and global facts. Saves go to the team.                                      | Its conversation history, kept per agent.                                                   |
| Claude Code    | Same as Clawboo Native.                                                                                | Your own Claude Code setup (`~/.claude`), shared by every Claude Code agent.                |
| Codex          | Same as Clawboo Native.                                                                                | A separate Codex home for each agent.                                                       |
| Hermes         | Same as Clawboo Native.                                                                                | Its own memory and skills, kept across runs in its home under `~/.clawboo/runtimes/hermes`. |
| OpenClaw       | Global facts only. It never sees facts saved for the team, and what it saves is visible to every team. | Whatever OpenClaw keeps for the agent.                                                      |

In team chat, agents look things up in memory when they decide to. Clawboo adds relevant facts to an agent's prompt by itself only for task runs started through the REST API or an agent routine. See [Memory](/using/memory).

## Who leads a mixed team

Boo Zero leads every team, whatever runtimes the members use. After an onboarding with only a ChatGPT sign-in, Boo Zero is the first Codex agent that onboarding created. Otherwise it is a Clawboo Native agent once any team has a Clawboo Native member and a native provider is connected, and the OpenClaw Gateway's default agent until then. See [Boo Zero](/using/boo-zero).

## Variations

| You want                              | Do this                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a member later                    | **Create Boo** and the graph's add button make an OpenClaw agent when the Gateway is connected, and a Clawboo Native agent otherwise. Claude Code, Codex and Hermes agents come only from a Marketplace deploy: a team, or one agent from the **Agents** tab, which makes a one-agent team. |
| Move a member to another runtime      | Deploy the team again with the new runtime, then delete the old team.                                                                                                                                                                                                                       |
| A code change in its own git checkout | Start the task through the REST API with a repository path. See [Hand a task from one runtime to another](/guides/cross-runtime-handoff).                                                                                                                                                   |
| No API key on any member              | Use local Ollama members and Codex members. See [Run Clawboo without an API key](/guides/no-api-key).                                                                                                                                                                                       |

## Troubleshooting

<AccordionGroup>

<Accordion title="A runtime in the menu shows Connect →">

**What it means:** that runtime is not connected yet.

**Fix:** close the dialog, connect the runtime in **Settings** > **Runtimes** until it reads **Connected**, then deploy the team again.

</Accordion>

<Accordion title="Claude Code is installed but the menu doesn't offer it">

**What it means:** Claude Code needs an Anthropic API key before it reads **Connected**. A signed-in `claude` CLI does not count.

**Fix:** connect an Anthropic API key on the Claude Code row in **Settings** > **Runtimes**. See [Claude Code](/runtimes/claude-code).

</Accordion>

<Accordion title="Connect an OpenClaw Gateway to deploy the OpenClaw members, or switch them to another runtime.">

**What it means:** at least one member is set to OpenClaw, and no OpenClaw Gateway is connected.

**Fix:** set those members to another runtime, or set up OpenClaw first. See [OpenClaw](/runtimes/openclaw).

</Accordion>

<Accordion title="No agents could be created. Check that the runtime is connected, then retry.">

**What it means:** no member could be created on its runtime. The new team stays, empty.

**Fix:** check each member's runtime in **Settings** > **Runtimes**. Then close the dialog, delete the empty team (right-click its icon in the team rail and choose **Delete team only**), and deploy from the **Marketplace** again. If only some members fail, a message lists them, for example "2 of 3 agents created".

</Accordion>

<Accordion title="An OpenClaw member doesn't know what the team saved">

**What it means:** OpenClaw agents read and save global facts only.

**Fix:** add the facts it needs under **Memory** in the sidebar. Facts you add there are global, so every agent can read them. Or give the work to a member on another runtime.

</Accordion>

<Accordion title="A Hermes member forgot what it learned">

**What it means:** each Hermes agent's memory lives in a home named after the agent's id. An agent you deploy again is a new agent with a new, empty home.

**Fix:** keep the original agent. Deleting it and deploying again starts its memory from scratch.

</Accordion>

</AccordionGroup>

## Next steps

- [Choose a runtime](/runtimes/index): what each runtime supports, side by side.
- [What agents can do](/concepts/permissions): permissions per runtime, before you give coding agents real work.
- [Hand a task from one runtime to another](/guides/cross-runtime-handoff): pause a coding task on one runtime and finish it on another.
- [Memory](/using/memory): browse and add the facts your team shares.
- [Budgets and spend](/using/budgets-and-spend): which runtimes report real cost and which are estimated.
