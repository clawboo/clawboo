---
title: 'Frequently asked questions'
sidebarTitle: 'FAQ'
description: 'Short answers about Clawboo: what you need, cost, privacy, where data lives, what agents can touch, remote access, updates and resets.'
icon: 'circle-help'
keywords:
  [
    'faq',
    'questions',
    'privacy',
    'telemetry',
    'cost',
    'free',
    'local model',
    'Ollama',
    'ChatGPT',
    'Windows',
    'multi-user',
    'update',
    'reset',
    'Atlas',
    'Ghost Graph',
    'connectors',
  ]
---

Short answers to the questions people ask most, each with a link to the page that covers it in full. If you are looking at an error message, go to [Troubleshooting](/help/troubleshooting).

## Getting started

### Do I need OpenClaw to use Clawboo?

No. Clawboo has a built-in runtime, Clawboo Native, that needs nothing else installed. In the setup wizard you connect one AI provider: an API key from Anthropic, OpenAI, OpenRouter or seven others, or a local Ollama, which needs no key. You can also sign in with your ChatGPT subscription, which runs your agents on Codex. OpenClaw is one of the runtimes you can add later. See the [Quickstart](/getting-started/quickstart) and [OpenClaw](/runtimes/openclaw).

### What is the difference between a provider and a runtime?

A provider supplies the AI model and bills you for it: Anthropic, OpenAI, OpenRouter, or Ollama on your own computer. A runtime is the program that runs an agent on that model, with its own tools and habits: Clawboo Native, OpenClaw, Claude Code, Codex or Hermes. One key can serve several runtimes. An Anthropic key, for example, works for Clawboo Native, Claude Code and Hermes. [Choose a runtime](/runtimes/index) compares them.

### Which runtimes can my agents use?

| Runtime        | What you install                                                                 | What it needs to run                                                                |
| -------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Clawboo Native | Nothing; it is built in                                                          | An API key from one of ten providers, or a local Ollama                             |
| OpenClaw       | OpenClaw and its Gateway; **Set up OpenClaw** installs both                      | A provider key, a ChatGPT sign-in or a local Ollama, and a one-time device approval |
| Claude Code    | The `claude` program, plus the Claude Agent SDK next to a global Clawboo install | An Anthropic API key                                                                |
| Codex          | The `codex` program                                                              | **Sign in with ChatGPT**                                                            |
| Hermes         | Hermes, which needs Python 3.11 to 3.13                                          | An OpenRouter, Anthropic or OpenAI key, or a ChatGPT sign-in                        |

**Settings > Runtimes** installs and connects each one, except the Agent SDK, which you install with `npm install -g clawboo @anthropic-ai/claude-agent-sdk`. One team can mix runtimes. See [Providers and runtimes](/using/providers-and-runtimes).

### Can I use my ChatGPT or Claude subscription instead of an API key?

A ChatGPT subscription, yes. **Sign in with ChatGPT** runs your agents on Codex under your ChatGPT plan, with no API key. Hermes and OpenClaw can sign in with ChatGPT too.

A Claude subscription, no. Claude Code agents in Clawboo need an Anthropic API key, and a `claude` program signed in with your Claude plan does not count. See [Run Clawboo without an API key](/guides/no-api-key).

### Can I run a local model?

Yes, with Ollama and Clawboo Native, and no key. Install Ollama and pull a chat model that can use tools, for example `ollama pull llama3.2`. Then choose **Ollama** in the setup wizard, or click **Use** on the Ollama row under **Settings > Runtimes > Clawboo Native > Manage**, then **Make default** on that row. Clawboo lists the models you have pulled and marks the ones that cannot use tools. If Ollama runs on another machine or port, set `OLLAMA_BASE_URL` before you start Clawboo. See [Run Clawboo without an API key](/guides/no-api-key).

On the 0.5.0 release, choosing Ollama during setup is not saved, so a new team tries Anthropic instead. [Known issues](/appendices/known-issues) lists this with the other fixes that arrive in the next release.

### Does Clawboo work on Windows?

Yes. Clawboo runs on macOS, Linux and Windows, with Node.js 22.12 or newer. On Windows, Clawboo Native agents cannot run shell commands, and OpenClaw's ChatGPT sign-in runs in a terminal you open yourself. The first start can also take longer while antivirus software scans the new files. See [Install](/getting-started/installation).

### Does Clawboo cost money?

Clawboo is free and open source under the MIT license, and there is no Clawboo account. You pay your AI provider for what your agents use. Ollama on your own computer costs nothing, and **Sign in with ChatGPT** uses the ChatGPT plan you already pay for. A team uses more tokens than a single assistant, because every hand-off is another model run. [Budgets and spend](/using/budgets-and-spend) shows how to watch spend and set a limit.

### Why does a local model show a cost?

A model your own Ollama serves costs nothing, so Clawboo records its runs at $0, shows the task as **free** and charges no budget. If one shows a cost, Clawboo did not count it as local. Ollama's cloud models (a `-cloud` tag) run on ollama.com, so they are estimated at a default rate, $3 per million input tokens and $15 per million output tokens, and marked **est.** An OpenClaw agent counts as local only when its model in `openclaw.json` is an `ollama/` one. [Budgets and spend](/using/budgets-and-spend) lists what each runtime reports.

### What should I ask my team first?

A job with clear parts and a clear result, such as "Write a welcome email series for new customers of our budgeting app: three short emails with subject lines, and a note on when to send each one." Boo Zero, your team leader, usually splits a job like that into tasks for teammates, then posts one summary when they finish. A quick question gets a direct answer. See [Work with your first team](/getting-started/first-team).

## Privacy and safety

### Is my data sent anywhere?

Prompts go only to the providers and apps you connect. There is no Clawboo account, and Clawboo itself sends no telemetry. Your teams, tasks, chats and memory stay in a database on your computer.

Clawboo makes a few requests of its own. The server downloads the Marketplace catalog from Clawboo's GitHub repository, asks the npm registry whether a newer Clawboo exists, and fetches OpenRouter's public model list for the model pickers, without a key. In your browser, the dashboard loads its font from Google Fonts and the repository's star count from GitHub. A connector you turn on talks to its own service. When you save a key, Clawboo checks it with one request to the provider's list of models. That request stores nothing, and if the check fails you can still save the key. See [Production defaults](/operating/production-defaults) and the [Security model](/operating/security).

### Where is my data stored?

In `~/.clawboo` on your computer, or the folder you set in `CLAWBOO_HOME`. It holds the database with your teams, tasks, chats and memory, your settings, the encrypted key vault, the server log and a folder for each team's files.

Clawboo also writes to OpenClaw's `~/.openclaw` folder in a few cases:

- Keys you save under **Settings > Providers** are copied there in plain text, so OpenClaw can use them.
- **Set up OpenClaw**, and the OpenClaw settings you change in the dashboard, write OpenClaw's own config.
- Each time it connects to your OpenClaw Gateway, Clawboo registers its tool servers there.
- If you run Clawboo's MCP servers from the command line, they use a separate database in `~/.openclaw/clawboo/` by default.

[Data and state](/operating/data-and-state) lists every file, with backup and reset steps.

### Can agents read my files or run commands?

It depends on the runtime:

- **Claude Code, Codex and Hermes** run with their own approval prompts and sandboxes turned off. They can read and change any file your user account can, and run commands, without asking you.
- **Clawboo Native** agents read and write files only inside the folder their run works in: their team's folder in team chat, in one-to-one chat and on research and review tasks, or the task's own git worktree. Commands stay off until you switch on **Let this Boo ask to run commands** on the agent's page, under **Details > Permissions**, and then every command asks you first.
- **OpenClaw** agents work in their own OpenClaw workspace, under OpenClaw's own sandbox settings. Their commands follow the **Command Execution** setting under **Details > Permissions** on their page: **Run Freely**, **Ask for Unknown** (where agents you create in Clawboo start) or **Always Ask**.

A git worktree keeps a task's file changes apart from your other files, but it is not a sandbox. For work you do not trust, run Clawboo as a separate user or in a virtual machine. See [What agents can do](/concepts/permissions).

### Can I open Clawboo from another computer, or share it with a colleague?

Clawboo is built for one person on one computer, with no user accounts or roles. Out of the box it listens only on that computer. To open it from somewhere else, follow [Reach Clawboo from another machine](/guides/self-host-securely). An SSH tunnel is the simplest way. Anything wider needs an access token (`STUDIO_ACCESS_TOKEN`), and anyone who has the token can do everything you can.

Use only letters, digits, `.`, `_`, `~` and `-` in the token: any other character switches the token check off. If you make the server listen on a network address with no working token, it refuses to start.

<Warning>

On clawboo 0.5.0 and older, a reverse proxy on the same machine leaves every `/api/mcp/` path open, even with an access token set. Deny all of `/api/mcp/` at the proxy, or upgrade once a release newer than 0.5.0 is out. The [Security model](/operating/security) has the rules for nginx, Caddy and Cloudflare Tunnel. Run `clawboo --version` to see your version.

</Warning>

## Working with your team

### Do I have to keep the dashboard open while agents work?

No, but the Clawboo server has to keep running. The server runs your team's work, so you can close the browser tab. `clawboo` starts the server in the background, and it keeps running after you close the terminal. Routines and background clean-up run in the server too: while it is stopped, routines wait, and a routine that came due fires once when the server runs again. See [How routines run](/concepts/scheduling).

### Where do I find what my team made?

Boo Zero posts a summary in the chat when the teammates finish. Each teammate's full result is saved on its task: open **Comments & activity** on the task card in the chat, or open the task on the **Board**. Agents return their results as text. Claude Code, Codex, Hermes and Clawboo Native can also write files. In team chat they start in their team's folder (`~/.clawboo/workspaces/<team id>`), which the agent's **Workspace** tab shows. Claude Code, Codex and Hermes can write anywhere you can, so name the folder you want when you ask for files elsewhere. See [Work with your first team](/getting-started/first-team).

### My agent is not doing what I asked. Where do I start?

With the checklist in [Troubleshooting](/help/troubleshooting#when-an-agent-is-not-doing-what-you-asked). The usual causes, most common first: the agent runs on another runtime or model than you think, it has no working provider, its model cannot use tools, or it never read your file. After those come an app that is not shared with the agent, an approval waiting in **Needs you**, a budget that paused the work and a blocked task.

### Why can't my agent use the app I connected?

Connecting an app under **Connectors** makes it available, but gives no agent access. Give it to each agent that needs it on a graph, such as the Org chart or a team graph: drag the connector onto the agent's Boo. The agent then has write access, and risky calls ask you first. Every agent already has the two browser connectors, Playwright and Chrome DevTools. OpenClaw agents cannot use connectors you share with them; they reach apps through Composio, and every such call asks you first. See [Connectors](/using/connectors).

### How do agents on different runtimes work together?

Through the team's chat and board. When the leader hands off work, Clawboo turns the hand-off into a task on the board and sends it to the teammate, whatever runtime it uses. The teammate's result lands on that task, and Clawboo sends it back to the leader. Every runtime can use the team's shared memory, except that OpenClaw agents see only global memory. See [How a team works](/intro/how-it-works).

### What is the difference between General and a room?

General is a team's main chat, with every member. A room is a separate chat with only the members you pick, for example for a side project, with its own conversation and task cards. Boo Zero leads General and every room, and all of a team's chats share its rules, brief, memory and board. See [Rooms](/using/team-chat#rooms).

### What is the difference between the Org chart and a team graph?

The Org chart shows all your teams at once, with Boo Zero, your team leader, above them. Open it from the sidebar, or with `Cmd+1` (`Ctrl+1` on Windows and Linux). A team graph is the **Team graph** card beside a team's chat, which draws only that team; in a room, the card is the **Room graph**. See [Org chart](/using/org-chart).

### Can agents work while I'm away?

Yes. A routine sends work on a schedule to a team or to one agent, for example every Monday at 9am. The Clawboo server must be running when it is due. When you come back, **Needs you** on the **Board** lists what waits for you: approvals, and failed or stopped tasks. Budgets only warn unless you choose a hard cap, and even a hard cap stops some kinds of runs only after they finish. See [Routines](/using/routines) and [Budgets and spend](/using/budgets-and-spend).

### My agent says the work is done. Did Clawboo check it?

Usually not. Clawboo checks work only on a task run that worked in its own copy of a git repository (a worktree) and changed files, and only the API starts those runs. Then it runs the task's test command and, for bigger or handed-off changes, has a second agent review the change. A failed check sends the task back to the agent once, then to **Needs you**. Nothing you start in the dashboard is checked: team chat, tasks on the **Board**, one-to-one chats, routines made in the dashboard and all OpenClaw work. Review those results yourself. See [How work is checked](/concepts/verification).

### How do I keep spending under control?

No budget exists until you add one in **Settings > Insights > Governance**. A new budget is **warn only** by default: Clawboo counts spend against the limit and turns the budget amber at 80%, but never pauses anything. Choose **hard cap** to pause work at the limit; what that stops depends on where the work runs. To halt a team right away, press **Stop** in its chat. See [Budgets and spend](/using/budgets-and-spend).

## Running and maintaining Clawboo

### How do I stop or restart the server?

```bash
clawboo stop
clawboo restart
```

`clawboo stop` is safe to run when nothing is running. `clawboo restart` starts a fresh server on the same port and opens your browser. With npx, run `npx clawboo@latest stop`. On a server protected by `STUDIO_ACCESS_TOKEN`, both commands refuse and print a command that stops the server by its port. See the [CLI reference](/reference/cli).

### How do I update Clawboo?

When a newer version is out, an **Update available** chip appears at the bottom left of the dashboard. On a global install, click it to update and restart. If you use npx, it copies `npx clawboo@latest` for you to run. From a terminal:

```bash
npm install -g clawboo@latest
clawboo restart
```

**Check for Updates** in **Settings > System** updates OpenClaw, not Clawboo. See [Update Clawboo](/getting-started/installation#update-clawboo).

### How do I reset Clawboo?

An upgrade needs no reset: a newer Clawboo adds what it needs to your database when it opens it. Reset only to wipe data, because a reset deletes data you cannot get back. Stop the server first, or it keeps serving the old database. If the server uses an access token, `clawboo stop` cannot stop it: stop it with Ctrl+C in its terminal, with your service manager, or with the command that `clawboo stop` prints, and delete files only after it has stopped.

To reset only the data, delete the database and its two side files. The `&&` deletes them only if `clawboo stop` succeeds:

```bash
clawboo stop && rm -f ~/.clawboo/clawboo.db ~/.clawboo/clawboo.db-wal ~/.clawboo/clawboo.db-shm
clawboo
```

Your provider keys and `settings.json` stay. Everything in the database starts over: teams and agents, the board, chats, memory, routines, budgets and most dashboard settings, including your default model. To reset everything, including the saved keys, delete the whole `~/.clawboo` folder instead. That also deletes task worktrees with any uncommitted work in them, and `clawboo backup` does not copy those, so commit or copy that work first. If you set `CLAWBOO_HOME`, use that folder in place of `~/.clawboo`.

Keys you saved under **Settings > Providers** also live in `~/.openclaw/.env`, which a reset does not touch. To keep a copy of the database first, run `clawboo backup`. See [Hard reset](/operating/data-and-state#hard-reset).

## Related

- [Troubleshooting](/help/troubleshooting): fixes, by the message you see.
- [Known issues](/appendices/known-issues): limitations we know about.
- [Glossary](/appendices/glossary): what each term means.
- [Key concepts](/concepts/index): how the pieces fit together.
