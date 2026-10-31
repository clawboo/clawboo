---
title: 'What agents can do'
sidebarTitle: 'What agents can do'
description: 'What each runtime can reach on your computer, when Clawboo stops to ask you first, and how to set up a safer install.'
icon: 'shield'
keywords:
  [
    'permissions',
    'sandbox',
    'safety',
    'security',
    'approvals',
    'bypassPermissions',
    'yolo',
    'danger-full-access',
    'worktree',
    'run_command',
  ]
---

An agent can act in two ways. It uses its runtime's own tools, such as a shell or a file editor, and it uses Clawboo's tools: the board, memory, the agents' [peer room](/concepts/peer-chat) and the connectors you share with it. This page answers two questions for each runtime. What can the agent reach? And when does Clawboo stop and ask you first?

The short answer: Claude Code, Codex and Hermes run with their own permission prompts and sandboxes turned off, so they can work unattended. Clawboo asks you before a smaller set of actions that pass through Clawboo itself.

<Warning>

A git worktree keeps two agents' file changes apart. It is not a sandbox. Claude Code, Codex and Hermes run as you: they can read and change any file your user account can, reach the network, and start other programs. Without a worktree, as in team chat or an agent's own chat, they start in their team's folder, `~/.clawboo/workspaces/<team id>`. That folder is only where they start, not a fence: from there they can still reach Clawboo's database and saved keys, like any other file you can open.

</Warning>

## Each runtime at a glance

| Runtime        | Its own prompts and sandbox                          | Where it works                                                                                                                                    | Clawboo asks you before                                             |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Clawboo Native | None of its own: Clawboo provides its tools          | Task runner with a repository: the task's worktree, except for research and review tasks. Otherwise, including one-to-one chat: the team's folder | Each shell command, once you turn shell commands on                 |
| Claude Code    | Off (`bypassPermissions`)                            | Task runner with a repository: the task's worktree, except for research and review tasks. Otherwise: the team's folder                            | Nothing it does with its own tools                                  |
| Codex          | Off (approval `never`, sandbox `danger-full-access`) | Same as Claude Code                                                                                                                               | Nothing it does with its own tools                                  |
| Hermes         | Off (`--yolo`)                                       | Same as Claude Code                                                                                                                               | Nothing it does with its own tools                                  |
| OpenClaw       | The OpenClaw Gateway's own settings                  | The agent's own OpenClaw workspace, never a Clawboo worktree                                                                                      | Shell commands, following the agent's **Command Execution** setting |

On every runtime, calls to connectors go through Clawboo and follow the rules in [Connectors](#connectors). Team chat and the task runner are the two ways Clawboo runs agents; [How a team works](/intro/how-it-works) explains which work takes which path.

## Clawboo Native

Clawboo itself runs these agents, so every tool they have is one Clawboo built:

- **In team chat, in one-to-one chat and on research and review tasks** it works in its team's folder, with tools to list, read and write files there. In one-to-one chat, an agent on no team works in `~/.clawboo/workspaces/_no-team`.
- **On a task-runner run with a repository** it gets the same tools inside the task's worktree.
- **File tools stay inside their folder.** A path outside it is refused, and so is a path that leads out of it through a symlink.
- **In every run** it also works through Clawboo's tools: the board, memory, the peer room, handing work to teammates, and the connectors you share with it.
- **Shell commands are off by default.** To turn them on for one agent, open its page, then **Details** > **Permissions**, and switch on **Let this Boo ask to run commands**.

With shell commands on, every command asks you first. There is no "Always" for them, and a card waits 10 minutes for your answer. One run can ask about at most 10 commands. Commands are offered only on runs that have a working folder, and never on Windows. A command you approve runs as you, with network access.

Each command is a program and its arguments, run directly rather than through a shell. Before a card reaches you, Clawboo turns away commands whose effect the card could not show:

- **59 named programs that run other commands**: shells such as `bash`, wrappers such as `env`, `xargs` and `sudo`, interpreters such as `python` and `node`, package runners such as `npx`, build tools such as `make`, and remote runners such as `ssh` and `docker`.
- **Scripts whose first line names one of them**, such as a file starting `#!/usr/bin/env python3`.
- **Programs given by a relative path**, such as `./build.sh`.

The list is matched on the program's file name, with versions such as `python3.11` included, and checked again on the real file after following links. It is a speed bump, not a boundary: programs that are not on it, such as `git`, `find` or `awk`, can still start a shell. Your answer on each card is the real control.

## Claude Code, Codex and Hermes

Clawboo starts these three runtimes with their own approval prompts and sandboxes turned off:

- **Claude Code** runs in permission mode `bypassPermissions`.
- **Codex** runs with approval policy `never` and sandbox `danger-full-access`.
- **Hermes** runs with `--yolo`.

They can run any command, edit any file and reach any address your user account can. Clawboo puts no approval step in front of their own tools.

Where they start depends on the path:

- **Task runner, with a repository:** in the task's own git worktree, a separate checkout under `~/.clawboo/worktrees`. That is their starting folder, not a fence. A task that changes files but names no repository is refused, rather than run somewhere else.
- **Task runner, research or review task:** no worktree, even with a repository. Agent Routines you create in the app run this way. They start in the team's folder, the same as team chat. A task with no team starts in a shared folder, `~/.clawboo/workspaces/_no-team`.
- **Team chat**, including board tasks you give an agent: no worktree. They start in the team's folder, `~/.clawboo/workspaces/<team id>` (under `CLAWBOO_HOME` when you set it). Every member and every room of the team shares this one folder.
- **One-to-one chat** on the agent's page: no worktree. They start in the team's folder, or in `~/.clawboo/workspaces/_no-team` for an agent on no team.

Clawboo creates the team's folder the first time a run needs it, readable only by your user account. If it cannot create the folder, the run does not start. The folder only sets where these runtimes start; it fences nothing in.

Before starting them, Clawboo removes its own secrets from the environment it passes on: the dashboard access token, the OpenClaw Gateway token and the key that unlocks Clawboo's saved keys. It also removes a list of common cloud and code-hosting tokens. This works by name and is best effort. A runtime can still read credential files on disk, such as `~/.openclaw/.env`, where keys saved on the **Providers** page are copied in plain text.

Claude Code starts without your own Claude Code setup: your `~/.claude` settings, plugins, hooks, MCP servers and memory do not apply. It still loads the Claude Code files of the folder it starts in, such as a repository's `CLAUDE.md` and `.claude/settings.json`. Leaving your setup out is not a sandbox: Claude Code can still read any file your user account can, `~/.claude` included.

## OpenClaw

OpenClaw agents run inside the OpenClaw Gateway, in workspaces the Gateway manages. Clawboo never gives them a worktree, and OpenClaw's own sandbox settings decide what they can touch ([OpenClaw sandboxing](https://docs.openclaw.ai/gateway/sandboxing)).

Shell commands follow each agent's **Command Execution** setting, on the agent's page under **Details** > **Permissions**:

| Setting             | What happens                                  |
| ------------------- | --------------------------------------------- |
| **Run Freely**      | Commands run without asking                   |
| **Ask for Unknown** | Asks before a command that is not on its list |
| **Always Ask**      | Asks before every command                     |

An OpenClaw agent you create in Clawboo starts on **Ask for Unknown**. The cards appear under **Needs you** and in the chat. Clawboo's server keeps them, so they wait even with the tab closed: until the Gateway's deadline, or 30 minutes when it sets none. [Command permissions](/using/command-permissions) shows what OpenClaw already allows without asking.

Clawboo also denies OpenClaw's own sub-agent tools (`sessions_spawn`, `sessions_yield`), so an OpenClaw agent cannot start helpers outside the team.

## Connectors

A connector links an outside app or tool, such as GitHub or a web browser. Every call to one goes through Clawboo, whatever runtime the agent uses:

- **An agent reaches a connector only after you share it.** Drag the connector onto the agent on the [Org chart](/using/org-chart) or a team graph, and pick **Read**, **Write** or **Admin**. Connecting a connector gives no agent access by itself.
- **Every new agent gets the two built-in browser connectors** (Playwright and Chrome DevTools) at **Write**. You can stop sharing them on the graph.
- **With Write, risky calls ask first.** For a connector that can reach the internet, any call that changes something asks you. When the card offers **Do not ask again for this for 30 days**, ticking it allows that tool for 30 days.
- **A run that might leak data always asks.** Once a run has read private data and taken in untrusted content, every connector call that can send data out asks you, and the card offers no way to skip it next time.
- **OpenClaw agents call connectors without an agent identity.** Connectors you share with an agent do not reach them, and their calls to apps through Composio ask you each time.

See [Connectors](/using/connectors) to connect and share them.

## What Clawboo checks itself

These controls are Clawboo's own. None of them adds an approval step to the tools Claude Code, Codex and Hermes bring with them.

### Approvals

Everything that waits for your yes lands in the same places: the **Needs you** column on the [Board](/using/board), the **Tasks** card in a team's chat, and cards in the chat itself. That covers Clawboo Native shell commands, OpenClaw shell commands, connector calls that need a yes, and risky hand-offs. [Approvals](/using/approvals) shows what each card does.

### Risky hand-offs

When an agent in team chat hands off a task whose text contains a risky word, the hand-off waits for you. The check matches whole words, in any letter case:

- delete, destroy, deploy, publish, release, secret, credential, prod, production
- the phrases drop table and rm -rf
- api_key, api-key or apikey, and force-push, force_push or forcepush

Other forms do not trigger it: "deleted", "deployment" and "secrets" pass, and so do "API key" and "force push" written with a space. The steps of a multi-step plan are not checked at all. If you choose **Don't allow**, or nobody answers within 5 minutes, the hand-off is skipped and the agent that handed it off is told.

The card in the dashboard offers only a one-time allow and **Don't allow**. The request is filed under the chat's leader. Nothing is remembered: an `allow_always` answer sent through the API allows that one hand-off, and the next risky hand-off asks again. [Budgets and guardrails](/concepts/governance) has the full rules.

### Budgets

A budget counts what your agents spend and warns you as it fills. That is the default. A **hard cap**, which pauses work at 100%, is opt-in. In team chat a hard cap does not keep new turns from starting, and it stops a run partway only on Clawboo Native with a model Clawboo prices. [Budgets and guardrails](/concepts/governance) has the details for each path.

### Circuit breakers

Only task-runner runs have circuit breakers. Such a run stops after more than 30 tool calls, the same failing call 3 times in a row, 6 tool results in a row that add nothing new, more than 200,000 tokens a minute, or 2 refusals in a row.

Team chat has its own limits instead. A turn can hand off at most 8 tasks, and hand-offs go at most three levels deep. Clawboo stops handing a task to a teammate that failed it 3 times, and stops a teammate that goes silent for 8 minutes. [Limits and defaults](/reference/limits-and-defaults) lists every number.

### Images in agent text

An image in an agent's markdown never loads on its own. In chat, a task's report and its comments, it shows as a link named after its alt text, and it opens only when you click it. That way an agent steered by something it read cannot send data out in an image's address without your click.

## What this does not cover

- **Clawboo sandboxes no runtime.** A worktree is a starting folder. The network, files outside it and other programs stay within reach of Claude Code, Codex and Hermes.
- **Approvals guard against a confused or misled model, not against programs on your computer.** With no access token set, any program on your computer can call Clawboo's API, including a command an agent runs, and it could answer an approval card itself. Setting `STUDIO_ACCESS_TOKEN` closes the API to other user accounts, and Clawboo never hands the token to the agents it starts. A program running as you can still read your files, including Clawboo's database and key vault, so nothing in Clawboo fully contains it. See [Security](/operating/security).
- **Clawboo does not limit where agents connect.** Runtimes reach their providers, and anything else on the network, directly. Only connector calls pass through Clawboo.

## A safer setup

- **Give Clawboo its own user account.** For work you do not fully trust, run Clawboo under a separate user account on your computer, or in a virtual machine. A coding runtime can then reach only what that account can.
- **Hand coding runtimes only work you would let them do unattended.** In team chat they run without prompts, and their team's folder does not limit what they can reach.
- **Connect only accounts you would hand to the agent yourself.** Share each connector only with the agents that need it, at **Read** unless they must change things.
- **Turn on shell commands sparingly.** Leave Clawboo Native shell commands off unless an agent needs them, and keep OpenClaw agents on **Ask for Unknown** or **Always Ask**.
- **Put a budget on spend**, and switch it to **hard cap** when money matters: see [Budgets and spend](/using/budgets-and-spend).
- **Set an access token** before you open Clawboo to other computers, and to keep other user accounts on this one out of the API: see [Self-host securely](/guides/self-host-securely).

<Accordion title="Under the hood">

- **Driver settings.** Claude Code runs through the Agent SDK `query()` with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`. It loads only the project settings source (`settingSources: ['project']`), with auto memory off and every `CLAUDE.md` above the working folder excluded (`apps/web/server/lib/runtimes/claudeCodeIsolation.ts`). Codex runs `codex app-server` with `approvalPolicy: 'never'` and `sandbox: 'danger-full-access'`; its `codex exec` fallback passes `--dangerously-bypass-approvals-and-sandbox` (`codexAppServerDriver.ts`, `codexDriver.ts`). Hermes runs `hermes chat` with `--yolo --accept-hooks` (`hermesDriver.ts`).
- **Working folder.** Team-chat runs (`serverDeliver.ts` and `runTeamExchange.ts` in `apps/web/server/lib/teamChat/`) and task-runner runs without a worktree set `cwd` to `<CLAWBOO_HOME>/workspaces/<teamId>`, or `workspaces/_no-team` for a task with no team, for Claude Code, Codex, Hermes and Clawboo Native (`apps/web/server/lib/runtimes/teamWorkdir.ts`). The folder is created with mode `0700` before the run starts, and a run whose folder cannot be created fails instead of starting in the server's working directory. One-to-one chat (`apps/web/server/lib/agentChat/driveAgentChat.ts`) sets the same `cwd` for those four runtimes, with `_no-team` for an agent on no team.
- **Task-runner isolation.** Task kinds `research` and `review` get no worktree. Any other kind needs a `repoPath`, or the run fails with `workspace_unavailable` (`apps/web/server/lib/executorRunner.ts`, `packages/worktrees/src/isolation.ts`).
- **Native tools.** `buildFileTools` and `buildExecTool` return no tools when the run has no `cwd` (`apps/web/server/lib/runtimes/native/`). The file tools refuse a path that is a symlink, or that resolves outside the `cwd` once every symlink above it is followed (`resolveJailedOnDisk` in `fileTools.ts`).
- **Environment scrubbing.** `apps/web/server/lib/runtimes/childEnv.ts` lists the removed variables.
- **Connector decisions.** `decideGrant` in `packages/governance/src/grants/decide.ts`; a new grant's approval policy defaults to `risk`.
- **Risky hand-offs.** The word list is in `apps/web/server/lib/teamChat/riskyDelegation.ts`. Each risky hand-off opens its own approval under the scope `delegate:code`, marked never-remember (`apps/web/server/api/delegationApproval.ts`).
- **No hidden approval layer.** The task runner's `routeApprovalsThroughClawboo` flag only adds a note to the prompt (`apps/web/server/lib/degradation.ts`).

</Accordion>

## Related

- [Approvals](/using/approvals): answer the cards under Needs you.
- [Command permissions](/using/command-permissions): what OpenClaw agents may already run without asking.
- [Budgets and guardrails](/concepts/governance): spend limits, caps and circuit breakers on each path.
- [Security](/operating/security): the access token and network exposure.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): what a worktree is for.
