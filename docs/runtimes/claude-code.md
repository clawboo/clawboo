---
title: 'Claude Code runtime'
sidebarTitle: 'Claude Code'
description: "Run agents on Anthropic's Claude Code: install it, connect an Anthropic API key, and see what it can do on your computer and what it costs."
keywords:
  ['claude-code', 'Claude Agent SDK', 'claude-agent-sdk', 'ANTHROPIC_API_KEY', 'bypassPermissions']
---

Claude Code is Anthropic's coding agent. Clawboo runs it through the Claude Agent SDK, so a Claude Code agent works with Claude Code's own tools: it reads and edits files, runs shell commands and fetches web pages. Clawboo records the cost Claude Code reports for each run. Use this page to set it up, see what Clawboo controls on it, and understand what it can do on your computer.

| Topic           | Claude Code                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| Best for        | Code changes and other file work on Anthropic models                         |
| You need        | An Anthropic API key, plus the Claude Agent SDK on an npm install of Clawboo |
| Who bills you   | Anthropic, per token, on your API key                                        |
| Cost in Clawboo | The real cost Claude Code reports                                            |
| Steering        | Your comments reach a running task                                           |

To compare it with the other runtimes, see [Choose a runtime](/runtimes/index).

## Before you begin

- Clawboo installed with npm (`npm install -g clawboo`) or running from source. A one-off `npx clawboo@latest` run cannot load the Agent SDK that Claude Code needs.
- Node.js 22.12 or newer, with npm.
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). A `claude` CLI signed in with a Claude subscription is not enough: Clawboo shows Claude Code as connected, and offers it for your agents, only when an Anthropic API key is available.

## Set up Claude Code

<Steps>

<Step title="Install the Claude Agent SDK">

Skip this step if you run Clawboo from source. On an npm install, install Clawboo and the SDK together:

```bash
npm install -g clawboo @anthropic-ai/claude-agent-sdk
```

The SDK has to sit next to Clawboo, which is why both install globally. Clawboo does not ship it, because its Claude Code binary adds about 210 MB to every install. If Clawboo is already running, restart it with `clawboo restart`.

</Step>

<Step title="Install Claude Code">

Open **Settings** (at the bottom of the left sidebar, or press Cmd+, on macOS and Ctrl+, on Windows or Linux), then **Runtimes**. On the **Claude Code** row, click **Install**, then **Install** in the panel that opens. Clawboo runs this and shows its output:

```bash
npm install -g @anthropic-ai/claude-code@2
```

You should see the row change to **Needs key**, or to **Connected** if an Anthropic key is already saved. If Claude Code is already installed on this computer, the row shows that state straight away.

</Step>

<Step title="Connect your Anthropic key">

Click **Connect** on the row, paste your key into the `ANTHROPIC_API_KEY` field, and click **Connect**. Clawboo checks the key with Anthropic before it saves it. If the check fails, the panel shows the reason; fix the key, or click **Connect anyway** when Anthropic is only unreachable from this computer.

You should see the row read **Connected**. If you already saved an Anthropic key under **Settings** > **Providers**, Claude Code reads **Connected** without this step.

</Step>

<Step title="Put a Claude Code agent on a team">

Create a team, and in **Customize team** set a member's runtime to **Claude Code**, then deploy the team. You can pick Claude Code there only while its row reads **Connected**; until then it is greyed out with "Connect in Runtimes". See [Teams](/using/teams) for the full flow.

</Step>

</Steps>

## What Clawboo controls on Claude Code

| What              | On Claude Code                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona           | The agent's `SOUL.md` (which the Personality sliders write into) is added to every prompt as a persona block, up to 4,000 characters.                                                             |
| `AGENTS.md`       | Draws the agent's links on the team graph. Claude Code never reads it.                                                                                                                            |
| Other agent files | Not used. `IDENTITY.md`, `TOOLS.md` and the rest are OpenClaw files; see [Agents](/using/agents).                                                                                                 |
| Model             | Team setup has no model picker for Claude Code. It runs the model its own Claude Code settings choose.                                                                                            |
| Clawboo tools     | Every run gets Clawboo's Tasks, Memory, Tools and TeamChat servers (MCP), so the agent can read the board, use shared memory and connectors, and talk to its team.                                |
| Leading a team    | A Claude Code leader hands work to teammates with the `team_delegate` tool.                                                                                                                       |
| Worktree          | Only a task-runner run that names a repository gets its own git worktree. Team chat and the tasks a team hands out run without one. See [Worktrees and handoff](/concepts/worktrees-and-handoff). |
| Steering          | Live. A comment on a running task joins the run at its next step, after the tool call in progress. See [Board](/using/board).                                                                     |
| Sessions          | No session carries over from one team chat turn to the next; each turn starts from the context Clawboo builds. See [What an agent sees](/concepts/agent-context).                                 |
| Memory            | Clawboo's shared memory, through the Memory tools. Claude Code also loads your own Claude Code settings and memory files (below).                                                                 |
| Cost              | The real cost each run reports. See [Costs](#costs).                                                                                                                                              |

### Your own Claude Code settings apply

Clawboo does not limit which settings files the Agent SDK loads. A Claude Code agent therefore reads the files your `claude` command reads: your user settings and memory in `~/.claude`, and any `.claude` settings and `CLAUDE.md` in the folder it works in. Every Claude Code agent shares them. Keep anything you do not want your agents to follow out of `~/.claude`, or run Clawboo under a separate user account.

## Permissions and safety

<Warning>

Clawboo starts Claude Code with its permission prompts turned off (`permissionMode: 'bypassPermissions'`). Nothing asks you before it runs a command, edits or deletes a file, or reaches the network. It runs as your user account and can read and change any file that account can.

</Warning>

- **A worktree is not a sandbox.** Only a task-runner run of a task that changes files, with a repository named, works in its own git worktree, which keeps its edits off your main checkout. Everywhere else there is no worktree: in team chat, and on research and review runs (which includes every agent Routine you create in the app), Claude Code starts in its team's folder, `~/.clawboo/workspaces/<team id>`, which every member of the team shares (a task with no team uses `workspaces/_no-team`). That folder only sets where it starts: Claude Code can still read and change any file your user account can, including Clawboo's database and key vault.
- **Clawboo's approvals do not cover Claude Code's own tools.** Calls the agent makes through Clawboo's Tools server (connectors, for example) go through Clawboo's checks and can ask you first. Claude Code's built-in shell, file and web tools never do.
- **Clawboo hides some secrets from it, by name only.** Before a run, Clawboo removes its own secrets (the OpenClaw Gateway token, the dashboard access token and the vault master key) from the environment Claude Code inherits. It also removes a fixed list of common credentials, such as GitHub, npm, cloud, Stripe, Slack and database variables. Other variables pass through, and credential files on disk stay readable.

For work you do not trust, run Clawboo under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) compares every runtime.

## Costs

Claude Code reports the dollar cost of each run, and Clawboo records that figure as reported, not as an estimate. It counts toward your budgets, and Anthropic bills the same usage to your API key. If a team chat run ends without reporting a cost (it failed early, say), Clawboo records an estimate from the length of the prompt and reply instead.

The cost arrives when a run finishes, so a hard cap cannot stop a Claude Code run partway through. See [Budgets and spend](/using/budgets-and-spend) for how each runtime's cost reaches your budgets.

## Disconnect Claude Code

In **Settings** > **Runtimes**, click **Manage** on the **Claude Code** row, then **Disconnect**. This deletes the Anthropic key from Clawboo's vault. The vault keeps one copy of each key for every runtime, so Clawboo Native and Hermes lose that key too unless they find it elsewhere. Until you connect Claude Code again, it also ignores an Anthropic key in your shell or in `~/.openclaw/.env`. To remove one key on purpose, or keep it for other runtimes, see [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

## Limits

- Team setup has no model picker for Claude Code members.
- It needs an Anthropic API key to read **Connected**; a Claude subscription sign-in alone doesn't count.
- A one-off `npx` run of Clawboo cannot load the Agent SDK.
- A hard cap counts Claude Code's cost only when each run ends.

## Troubleshooting

<AccordionGroup>

<Accordion title="The run failed: The Claude Code runtime needs @anthropic-ai/claude-agent-sdk">

The full message continues "which this clawboo install does not ship". The row reads **Connected** because that only checks the `claude` command and your key; the Agent SDK is a separate package.

Install it next to Clawboo with `npm install -g clawboo @anthropic-ai/claude-agent-sdk`, run `clawboo restart`, then send the message or start the task again. If you started Clawboo with `npx`, switch to the global install first.

</Accordion>

<Accordion title="Claude Code reads Needs key, but my claude CLI is signed in">

Clawboo needs an Anthropic API key for Claude Code; the CLI's own sign-in does not count. Connect a key on the row, or save one under **Settings** > **Providers**. An `ANTHROPIC_API_KEY` set in the environment Clawboo runs with also counts.

</Accordion>

<Accordion title="Claude Code is greyed out in Customize team (Connect in Runtimes)">

The runtime is not connected. Finish [Set up Claude Code](#set-up-claude-code) until the row reads **Connected**, then open **Customize team** again.

</Accordion>

<Accordion title="Invalid API key.">

Anthropic rejected the key. Copy it again from [console.anthropic.com](https://console.anthropic.com/settings/keys), or create a new one, and connect it.

</Accordion>

<Accordion title="Could not reach anthropic (timed out).">

The key check could not reach Anthropic from this computer. Check your network or proxy. If you are sure the key is right, click **Connect anyway** to save it without the check.

</Accordion>

<Accordion title="Permission denied. A global install may require elevated permissions.">

npm could not write to its global folder. The message suggests `sudo npm install -g @anthropic-ai/claude-code@2`. A Node version manager such as nvm or fnm avoids the problem without `sudo`; install Node through one, then click **Install** again.

</Accordion>

<Accordion title="npm not found. Install Node.js (which bundles npm) and retry.">

The Clawboo server cannot find npm. Install Node.js 22.12 or newer, restart Clawboo with `clawboo restart`, then click **Install** again.

</Accordion>

</AccordionGroup>

## Check that it works

1. In **Settings** > **Runtimes**, the **Claude Code** row reads **Connected**.
2. Open the team chat of a team with a Claude Code member. Type `@`, pick that agent, and ask: "Say hello in one sentence."
3. You should see a reply under the agent's name. If the run fails, the chat shows "The run failed:" and the reason; look it up in [Troubleshooting](#troubleshooting).

<Accordion title="Under the hood">

- Clawboo calls the SDK's `query()` with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`. It also passes the run's working folder (the task's worktree, or else the team's folder), the model when a run names one, a session to resume, Clawboo's four MCP servers over HTTP, and the scrubbed environment plus the connected key. It does not set `settingSources`, so the SDK loads user, project and local settings.
- The SDK starts Claude Code from its own platform package. The `claude` command that **Install** adds is what the Runtimes row checks for. A source build of Clawboo uses SDK version 0.3.268.
- Run a board task on Claude Code directly with `POST /api/runtimes/claude-code/run`; see the [Runtimes API](/reference/rest-api/runtimes). Such a run falls back to the `claude` CLI's own sign-in when no Anthropic key is available.
- A run that hits Claude Code's turn limit ends cleanly, and the task runner continues the task in a fresh session with a handoff note.

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Claude Code compares with the other runtimes.
- [Connect AI providers and runtimes](/using/providers-and-runtimes): keys, sign-ins and what Disconnect removes.
- [What agents can do](/concepts/permissions): permissions and safety for every runtime.
- [Budgets and spend](/using/budgets-and-spend): how cost reaches your budgets.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): when a run gets its own git worktree.
