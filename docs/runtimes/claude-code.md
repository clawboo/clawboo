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
npm install -g clawboo @anthropic-ai/claude-agent-sdk@0.3
```

The SDK has to sit next to Clawboo, which is why both install globally. Clawboo does not ship it, because its Claude Code binary adds about 210 MB to every install. If Clawboo is already running, restart it with `clawboo restart`.

</Step>

<Step title="Check the Claude Code row">

Open **Settings** (at the bottom of the left sidebar, or press Cmd+, on macOS and Ctrl+, on Windows or Linux), then **Runtimes**. You should see the **Claude Code** row read **Needs key**, or **Connected** if an Anthropic key is already saved. A Claude Code run loads the SDK and starts the SDK's own `claude` binary, which came with the SDK in the step above, so there is nothing more to install. A `claude` CLI on your `PATH` is not used and does not count: without the SDK the row reads **Not installed**.

If the row reads **Not installed**, on a global install of Clawboo click **Install**: it runs `npm install -g @anthropic-ai/claude-agent-sdk@0.3`, which puts the SDK next to Clawboo. A one-off `npx` run and a source checkout cannot load an SDK installed that way, so there the button explains what to run instead. If it still reads **Not installed**, check that the SDK sits next to Clawboo (`npm ls -g @anthropic-ai/claude-agent-sdk`) and that npm installed its platform package (an install with `--omit=optional` leaves the binary out), then run `clawboo restart`.

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
| Model             | Team setup has no model picker for Claude Code. A run that names no model gets Claude Code's default, or `ANTHROPIC_MODEL` when it is set in the environment Clawboo runs with.                   |
| Clawboo tools     | Every run gets Clawboo's Tasks, Memory, Tools and TeamChat servers (MCP), so the agent can read the board, use shared memory and connectors, and talk to its team.                                |
| Leading a team    | A Claude Code leader hands work to teammates with the `team_delegate` tool.                                                                                                                       |
| Worktree          | Only a task-runner run that names a repository gets its own git worktree. Team chat and the tasks a team hands out run without one. See [Worktrees and handoff](/concepts/worktrees-and-handoff). |
| Steering          | Live. A comment on a running task joins the run at its next step, after the tool call in progress. See [Board](/using/board).                                                                     |
| Sessions          | Each team chat turn starts fresh from the context Clawboo builds. Its one-to-one chat resumes one session until `/reset`. See [What an agent sees](/concepts/agent-context).                      |
| Memory            | Clawboo's shared memory, through the Memory tools, and the `CLAUDE.md` of the folder it works in. Your own Claude Code memory is left out (below).                                                |
| Cost              | The real cost each run reports. See [Costs](#costs).                                                                                                                                              |

### Your own Claude Code setup stays out

Clawboo starts Claude Code without your own Claude Code setup. A Claude Code agent does not load:

- your user settings in `~/.claude/settings.json`: plugins, hooks, `env`, permissions, model and effort level
- the MCP servers you added to your own Claude Code
- your `~/.claude/CLAUDE.md` and `~/.claude/rules`, or a `CLAUDE.md` in any folder above the one it works in
- Claude Code's auto memory, so it neither reads nor writes the notes Claude Code keeps for a repository

It still loads the Claude Code files of the folder it works in. In a task's worktree that is the repository's `CLAUDE.md`, `.claude/settings.json` (hooks included) and `.mcp.json`, as anyone who clones the repository gets them.

This does not change how Claude Code signs in. Clawboo passes your Anthropic key in Claude Code's environment, and the `claude` command's own sign-in is not kept in a settings file. If your Claude Code reaches Anthropic through `~/.claude/settings.json`, for example an `env` block that sets `ANTHROPIC_BASE_URL` or an `apiKeyHelper`, that no longer applies to agents: set the same variables in the environment you start Clawboo with.

Leaving your setup out is not a sandbox. Claude Code can still read any file your user account can, `~/.claude` included.

## Permissions and safety

<Warning>

Clawboo starts Claude Code with its permission prompts turned off (`permissionMode: 'bypassPermissions'`). Nothing asks you before it runs a command, edits or deletes a file, or reaches the network. It runs as your user account and can read and change any file that account can.

</Warning>

- **A worktree is not a sandbox.** Only a task-runner run of a task that changes files, with a repository named, works in its own git worktree, which keeps its edits off your main checkout. Everywhere else there is no worktree: in team chat, in the agent's own chat, and on research and review runs (which includes every agent Routine you create in the app), Claude Code starts in its team's folder, `teams/<team id>` in the [work folder](/operating/data-and-state#the-work-folder) (`~/clawboo-work` by default), which every member of the team shares (a task or an agent with no team uses `teams/_no-team`). The work folder sits outside Clawboo's data folder, so `../..` from there does not reach the database. That folder only sets where it starts: Claude Code can still read and change any file your user account can, including Clawboo's database and key vault in `~/.clawboo`, by their full path.
- **Clawboo's approvals do not cover Claude Code's own tools.** Calls the agent makes through Clawboo's Tools server (connectors, for example) go through Clawboo's checks and can ask you first. Claude Code's built-in shell, file and web tools never do.
- **Clawboo hides some secrets from it, by name only.** Before a run, Clawboo removes its own secrets (the OpenClaw Gateway token, the dashboard access token and the vault master key) from the environment Claude Code inherits. It also removes a fixed list of common credentials, such as GitHub, npm, cloud, Stripe, Slack and database variables, and the variables that tie a process to a Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`), so a Clawboo started from a terminal inside Claude Code does not hand that session to its agents. Claude Code settings such as `CLAUDE_CODE_USE_BEDROCK` pass through, like every other variable not on these lists, and credential files on disk stay readable.

For work you do not trust, run Clawboo under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) compares every runtime.

## Costs

Claude Code reports the dollar cost of each run, and Clawboo records that figure as reported, not as an estimate. It counts toward your budgets, and Anthropic bills the same usage to your API key. If a run in team chat or in the agent's own chat ends without reporting a cost (it failed early, say), Clawboo records an estimate from the length of the prompt and reply instead.

The cost arrives when a run finishes, so a hard cap cannot stop a Claude Code run partway through. When that last report takes a hard cap past its limit, the finished result is kept and posted, and the next run is refused. A routine or API run that ends without reporting a cost is estimated the same way as in team chat. See [Budgets and spend](/using/budgets-and-spend) for how each runtime's cost reaches your budgets.

## Disconnect Claude Code

In **Settings** > **Runtimes**, click **Manage** on the **Claude Code** row, then **Disconnect**. This deletes the Anthropic key from Clawboo's vault. The vault keeps one copy of each key for every runtime, so Clawboo Native and Hermes lose that key too unless they find it elsewhere. Until you connect Claude Code again, it also ignores an Anthropic key in your shell or in `~/.openclaw/.env`. To remove one key on purpose, or keep it for other runtimes, see [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

## Limits

- Team setup has no model picker for Claude Code members.
- It needs an Anthropic API key to read **Connected**; a Claude subscription sign-in alone doesn't count.
- A one-off `npx` run of Clawboo cannot load the Agent SDK.
- A hard cap counts Claude Code's cost only when each run ends, so it refuses the next run rather than stopping the current one.

## Troubleshooting

<AccordionGroup>

<Accordion title="The run failed: The Claude Code runtime needs @anthropic-ai/claude-agent-sdk">

The full message continues "which this clawboo install does not ship". The Agent SDK is missing or cannot load from this Clawboo, and the **Claude Code** row under **Runtimes** reads **Not installed**. Agents already on Claude Code still try to run and fail this way until it is installed.

Install it next to Clawboo with `npm install -g clawboo @anthropic-ai/claude-agent-sdk@0.3`, run `clawboo restart`, then send the message or start the task again. If you started Clawboo with `npx`, switch to the global install first.

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

<Accordion title="The run failed: Invalid API key (HTTP 401), or a billing or rate-limit message">

The run reached Anthropic, and Anthropic refused it: a key that is wrong or revoked, an expired sign-in, an account out of credit, or too many requests. The run ends as failed with Anthropic's own message and the HTTP status, and a task it was working on fails rather than counting as done. Fix the key or the account, then send the message or start the task again.

</Accordion>

<Accordion title="Could not reach anthropic (timed out).">

The key check could not reach Anthropic from this computer. Check your network or proxy. If you are sure the key is right, click **Connect anyway** to save it without the check.

</Accordion>

<Accordion title="Permission denied. A global install may require elevated permissions.">

npm could not write to its global folder. The message suggests `sudo npm install -g @anthropic-ai/claude-agent-sdk@0.3`. A Node version manager such as nvm or fnm avoids the problem without `sudo`; install Node through one, then click **Install** again.

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

- Clawboo calls the SDK's `query()` with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`. It also passes the run's working folder (the task's worktree, or else the team's folder), the model when a run names one, a session to resume, Clawboo's four MCP servers over HTTP, and the scrubbed environment plus the connected key. It sets `settingSources: ['project']`, passes `settings` with `autoMemoryEnabled: false` and a `claudeMdExcludes` list that covers every folder above the working folder and your home folder, and sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the environment, over any value Clawboo itself runs with.
- Claude Code files its saved sessions under the folder they ran in. When Clawboo moves a team folder into the [work folder](/operating/data-and-state#move-older-work-into-it), it drops the session ids it saved for Claude Code agents (1:1 chat, team chat and task pointers), and when it moves a task checkout, the session id in that checkout's handoff. The next turn starts a fresh session with the brief and the chat history. Codex, Hermes and Clawboo Native agents keep their sessions.
- The SDK starts Claude Code from its own platform package. The `claude` command that **Install** adds is what the Runtimes row checks for. A source build of Clawboo uses SDK version 0.3.268.
- Run a board task on Claude Code directly with `POST /api/runtimes/claude-code/run`; see the [Runtimes API](/reference/rest-api/runtimes). Such a run falls back to the `claude` CLI's own sign-in when no Anthropic key is available.
- A run that hits Claude Code's turn limit ends cleanly, and the task runner continues the task in a fresh session with a handoff note. So does a run whose conversation outgrew the model's context window: it ends out of room rather than failed, with a non-fatal error coded `context_overflow` that says why. Three values of a `result`'s `terminal_reason` mean that: `prompt_too_long` (the API refused the prompt and compaction could not make it fit), `blocking_limit` (Claude Code's own count reached its limit with no compaction to fall back on, so it refused before calling the API) and `rapid_refill_breaker` (the context refilled to the limit within 3 turns of a compaction, 3 times in a row, so it gave up compacting). Clawboo does not resume such a session. In team chat, where nothing restarts by itself, the task is blocked and its saved session dropped, and **Retry** runs it in a fresh session. In a one-to-one chat, the next message starts fresh and the chat says so. Claude Code's own text for these endings, such as advice to use its `/clear`, is never shown as the agent's reply. It goes on the board as the failure's detail, so a task that ran out of room this way says why.
- An API error reaches the SDK as an assistant message with an `error` field (`authentication_failed`, `billing_error`, `rate_limit`, ...) and then a `result` with `subtype: 'success'` and `is_error: true`. Clawboo reads that pair as a failed run carrying the `error` value as its code, and does not show the error notice as the agent's reply. A refused key or login (`authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error`) is filed as `Auth` and a refused account (`billing_error`, `account_on_hold`, `verification_required`) as `Billing`, so the task waits in **Needs you** with **Fix sign-in** instead of being retried; see [Error classes](/reference/events-and-errors#error-classes). Other failed results, such as `error_during_execution`, keep the cause from their `errors` list.

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Claude Code compares with the other runtimes.
- [Connect AI providers and runtimes](/using/providers-and-runtimes): keys, sign-ins and what Disconnect removes.
- [What agents can do](/concepts/permissions): permissions and safety for every runtime.
- [Budgets and spend](/using/budgets-and-spend): how cost reaches your budgets.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): when a run gets its own git worktree.
