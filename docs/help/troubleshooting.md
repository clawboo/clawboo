---
title: 'Troubleshooting'
sidebarTitle: 'Troubleshooting'
description: 'Find the message you see and fix it: start-up, providers and Ollama, runtimes and the OpenClaw Gateway, team chat, the board, budgets and remote access.'
icon: 'life-buoy'
keywords:
  [
    'troubleshooting',
    'errors',
    'error messages',
    'not working',
    'help',
    'debug',
    'agent not replying',
    'Too many requests',
    'Cross-origin request blocked',
    'Dashboard is taking too long to start',
  ]
---

Use this page when something in Clawboo does not work. Start with the five quick checks below. Then find the message you see: entries are grouped by area, and each one says what the message means, how to fix it, and how to avoid it next time. Each entry links to the page that covers its topic in full.

## First 60 seconds

<Steps>

<Step title="Check that the server is running">

Run `clawboo` in a terminal (`npx clawboo@latest` if you use npx). It finds the Clawboo server that is already running, or starts one, then opens your browser and prints the address after **Clawboo opened at**. Use that address. It is `http://localhost:18790` unless that port was taken.

If the command prints a message instead, look it up under [Install and launch](#install-and-launch).

</Step>

<Step title="Read the server log">

The server writes its log to `~/.clawboo/server.log` (to the folder in `CLAWBOO_HOME`, if you set it). Show the last lines:

<Tabs>

<Tab title="macOS and Linux">

```bash
tail -n 50 ~/.clawboo/server.log
```

</Tab>

<Tab title="Windows">

```powershell
Get-Content "$HOME\.clawboo\server.log" -Tail 50
```

</Tab>

</Tabs>

A server you start yourself with `node` logs to its terminal instead. After an update from the dashboard, the restarted server writes no log until you run `clawboo restart`.

</Step>

<Step title="Open System Health">

In the dashboard, open **Settings** (in the sidebar, or press `Cmd+,` on a Mac and `Ctrl+,` elsewhere), then **System Health**. Each startup check reads **OK**, **Degraded** or **Fatal**, with a line on what it found. A failed check does not stop the server: it keeps serving and reports the problem here. Fix what the check names, then click **Re-run probe**. See [System Health](/using/system-health).

</Step>

<Step title="Check that a provider is connected">

Open **Settings > Runtimes**. The runtime your agents use should read **Connected**. **Needs key**, **Needs login** or **Not installed** means it cannot run agents yet. The keys you saved are listed under **Settings > Providers**. See [Providers and runtimes](/using/providers-and-runtimes).

</Step>

<Step title="Read the notice, then look in Needs you">

When a run fails before the agent writes anything, the chat shows a notice with the reason. Find that notice on this page. Then open the **Board**: its **Needs you** column holds approvals waiting for an answer and tasks that will not move by themselves.

</Step>

</Steps>

If none of this helps, go through [When an agent is not doing what you asked](#when-an-agent-is-not-doing-what-you-asked), or [report a bug](#report-a-bug).

## Install and launch

### Clawboo requires Node.js 22.12 or newer

**What it means:** your Node.js is older than Clawboo needs. The message names the version you have.

**Fix:** install a current Node.js from [nodejs.org](https://nodejs.org), or switch with a version manager (`nvm install 22` or `fnm use 22`). Then run `clawboo` again.

**Prevent it:** if you plan to add OpenClaw, choose a Node.js version in OpenClaw's narrower range, listed under [Before you begin](/runtimes/openclaw#before-you-begin).

### Dashboard is taking too long to start.

**What it means:** `clawboo` started the server but did not hear back from it within 45 seconds. Below the message it prints the last lines of the server log and the log's full path.

**Fix:** read those log lines. They point to one of three cases:

1. **An error.** For example "CLAWBOO_API_PORT=18800 is already in use.", "No free port available in range 18790-18809." or a line that starts with "SECURITY: refusing to start". Find the message on this page, fix it, then run `clawboo` again.
2. **You set `STUDIO_ACCESS_TOKEN`, and the log has a line containing `Clawboo ready`.** The server is running. The command cannot confirm a server protected by an access token, so it gives up after 45 seconds and exits with an error. Open `http://localhost:<port>/?access_token=<your token>` in your browser; the port is in `~/.clawboo/api-port.txt`.
3. **No error, on a first start on Windows.** Antivirus software scanning the new files can slow the first start. Run `clawboo` again.

**Prevent it:** start a token-protected server directly or as a service, not with `clawboo`. [Run the Clawboo server](/operating/deployment#start-the-server-directly) and [Reach Clawboo from another machine](/guides/self-host-securely) show how.

### A Clawboo server is running on port N, but it requires an access token.

**What it means:** this install sets `STUDIO_ACCESS_TOKEN`, so the server answers only browsers that carry its access cookie, and the command cannot use it. It does not start a second server.

**Fix:** open `http://localhost:<port>/?access_token=<your token>` once in your browser, with the port the message names. `clawboo stop` and `clawboo restart` refuse to touch this server too; they print a command that stops it by its port.

**Prevent it:** manage a token-protected server with its own terminal or a service manager. See [Token-gated installs](/reference/cli#token-gated-installs).

### Could not find the Clawboo server.

**What it means:** the command could not find the server files that come with it, so the install is incomplete.

**Fix:** reinstall with `npm install -g clawboo`, or run `npx clawboo@latest`.

### More install messages

<AccordionGroup>

<Accordion title="CLAWBOO_API_PORT=N is already in use.">

**What it means:** you set `CLAWBOO_API_PORT`, and another program already uses that port. With this variable set, Clawboo uses exactly that port and does not look for another.

**Fix:** free the port, choose another one, or unset `CLAWBOO_API_PORT` so Clawboo picks a free port from 18790 to 18809. If an older Clawboo holds the port, run `clawboo stop` first. A `PORT` variable set by a hosting platform works the same way and fails with "PORT=N is already in use (set by hosting platform)."

</Accordion>

<Accordion title="No free port available in range 18790-18809.">

**What it means:** all 20 ports Clawboo tries are taken, often by older Clawboo servers or by other programs.

**Fix:** run `clawboo stop`, or set `CLAWBOO_API_PORT` to a port you know is free.

</Accordion>

<Accordion title="The dashboard opened on an unexpected port">

**What it means:** your shell sets a `PORT` variable, and Clawboo uses it in place of 18790.

**Fix:** unset `PORT`, or choose a port with `CLAWBOO_API_PORT`. The address that `clawboo` prints is always the right one.

</Accordion>

<Accordion title="The browser didn't open">

**What it means:** Clawboo could not open a browser, for example on a computer without a screen. The server runs anyway.

**Fix:** open the address printed after **Clawboo opened at**, usually `http://localhost:18790`.

</Accordion>

<Accordion title="No Gateway detected">

**What it means:** this line is information only. On every start, `clawboo` checks whether an OpenClaw Gateway answers on its default port, 18789.

**Fix:** nothing to fix. You need a Gateway only for OpenClaw agents; see [OpenClaw](/runtimes/openclaw).

</Accordion>

<Accordion title="The previous server was stopped and could not be replaced.">

**What it means:** `clawboo` or `clawboo restart` stopped an older server to start a newer one, and the new one did not start. No server is running.

**Fix:** read the server log for the reason, then run `clawboo`.

</Accordion>

<Accordion title="The update chip says the update failed">

**What it means:** the **Update available** chip shows npm's own reason. "Permission denied. A global install needs elevated permissions." means npm cannot write to its global folder, which is common with a Node.js installed for the whole system.

**Fix:** run the update in a terminal (`npm install -g clawboo@latest`, then `clawboo restart`), or install Node.js with a version manager such as nvm or fnm, which keeps global packages in your home folder. If the update installed but the page did not come back, run `clawboo restart`. See [Update Clawboo](/getting-started/installation#update-clawboo).

</Accordion>

</AccordionGroup>

## Onboarding and providers

Clawboo checks a key before it saves one, with a single request to the provider's list of models. During setup, a failed check reads **Key didn't verify**, followed by one of the reasons below.

### Invalid API key.

**What it means:** the provider turned the key down.

**Fix:**

1. Copy the key again from the provider's key page, or create a new one.
2. Check that you picked the provider the key belongs to.
3. Paste it again and save.

### Could not reach openai (timed out).

**What it means:** this computer could not reach the provider within 8 seconds. The message names the provider; without "(timed out)" the connection failed outright. A proxy, a firewall or no network is the usual cause.

**Fix:** fix the connection and try again. If you are sure the key is right, save it without the check: **Continue anyway** during setup, **Save anyway** under **Settings > Providers**, or **Connect anyway** on a runtime's row.

### Clawboo Native has no provider key connected.

**What it means:** a Clawboo Native agent tried to run, and its provider has no key Clawboo can use. The full notice reads "Open Settings → Runtimes → Clawboo Native to connect a provider." The agent's page header also reads **Disconnected** or **No provider key**.

**Fix:** save a key for that provider under **Settings > Providers**, or open **Settings > Runtimes > Clawboo Native** and connect a provider. If you disconnected Clawboo Native earlier, click **Connect** on its row and choose a saved key with **Use**.

**Prevent it:** a runtime's **Disconnect** also deletes keys that other runtimes share; see [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

### Ollama isn't answering on this machine. Start it (ollama serve) and try again.

**What it means:** Clawboo could not reach Ollama, at `http://localhost:11434` unless you set `OLLAMA_BASE_URL`. During setup, the same problem reads "Ollama isn't answering."

**Fix:** open the Ollama app, or run `ollama serve`, then try again. Don't have Ollama? The setup screen links to its download.

### Ollama doesn't have llama3.2 yet, so this run couldn't start.

**What it means:** the agent's model is not pulled into your Ollama. The message names the model and the command that pulls it.

**Fix:** run the command, for example `ollama pull llama3.2`, then send your message again. Or pick a model you have pulled in the agent's model control. **Check again** on the Ollama row refreshes the list of models.

### This model can't use tools, and this agent needs them

**What it means:** the message starts with the model's name. Agents need tools to hand off work, use the board and reach apps, and this model has none. In the model list, Clawboo marks such models **(can't use tools)**.

**Fix:** pick a model that can use tools, or pull one, for example with `ollama pull llama3.2`.

**Prevent it:** pull a model that supports tools before you deploy a team on Ollama. See [Run Clawboo without an API key](/guides/no-api-key).

### More provider messages

<AccordionGroup>

<Accordion title="Provider returned 429.">

**What it means:** the provider answered the key check with an error other than a rejected key; the number varies. 429 means the provider is limiting your requests. A number from 500 up is a problem on the provider's side.

**Fix:** wait a moment, check your account with the provider, then try again.

</Accordion>

<Accordion title="Ollama is running, but has no chat model yet.">

**What it means:** Ollama answers, but it has no model that can chat. Models made only for search (embedding models) do not count.

**Fix:** run `ollama pull llama3.2`, then click **Check again**.

</Accordion>

<Accordion title="The codex CLI isn't installed yet. Install it first, then sign in.">

**What it means:** **Sign in with ChatGPT** runs through Codex, which is not installed yet.

**Fix:** install Codex from **Settings > Runtimes > Codex**, or with the **Install Codex** button during setup, then sign in again.

</Accordion>

<Accordion title="Sign-in timed out. Try again.">

**What it means:** the ChatGPT sign-in in your browser was not finished in time.

**Fix:** click **Retry**. Or run `codex login` in a terminal, then click **Re-check** on the **Codex** row.

</Accordion>

<Accordion title="My team stopped working after I disconnected another runtime">

**What it means:** **Disconnect** on a runtime deletes every saved key that runtime uses, and runtimes share keys. Disconnecting Claude Code, for example, deletes the Anthropic key that Clawboo Native and Hermes may also use.

**Fix:** save the key again under **Settings > Providers**. See [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

</Accordion>

<Accordion title="The Marketplace shows only 5 teams and 15 agents">

**What it means:** Clawboo could not download the Marketplace catalog from GitHub, so it shows its built-in teams. **Showing the built-in teams only.** with a **Try again** button means your browser could not reach the server.

**Fix:** check your network, then click **Try again** if it is shown. Restarting Clawboo makes the server download the catalog again. See [Marketplace](/using/marketplace).

</Accordion>

</AccordionGroup>

## Runtimes and the OpenClaw Gateway

### Approve this device

**What it means:** OpenClaw asks you to approve each new device once before it lets Clawboo connect. The setup shows this card; an error that mentions `NOT_PAIRED` means the same thing.

**Fix:**

1. Click **Approve this device** on the card.
2. If the setup then says "OpenClaw still needs this device approved. Retry to approve it again.", click **Retry** for a fresh card.
3. If the card keeps failing, approve from a terminal, as [Approve from a terminal instead](/runtimes/openclaw#approve-from-a-terminal-instead) shows. Then click **Set up OpenClaw** or **Reconnect OpenClaw** again.

### OpenClaw Gateway is offline

**What it means:** the OpenClaw Gateway stopped, or Clawboo cannot reach it ("OpenClaw Gateway is unreachable"). Your OpenClaw agents are paused; agents on other runtimes keep working.

**Fix:** click **Reconnect** on the banner, or **Reconnect OpenClaw** in **Settings > Runtimes**. If the banner offers **Restart Gateway** instead, the Gateway turned down Clawboo's token, which it reads only when it starts; click it.

### Could not reach your OpenClaw agents

**What it means:** a team-chat message for an OpenClaw agent could not be delivered, because the Gateway is not running. Clawboo reconnects and retries once before it shows this notice.

**Fix:** bring the Gateway back with **Reconnect OpenClaw** in **Settings > Runtimes** (or **Reconnect** on the banner), then send the message again.

### The Claude Code runtime needs @anthropic-ai/claude-agent-sdk

**What it means:** a Claude Code run failed because the Claude Agent SDK is missing. The `clawboo` package leaves it out because it would add about 210 MB to every install. The **Claude Code** row can still read **Connected**, because that checks only the `claude` program and your key.

**Fix:**

```bash
npm install -g clawboo @anthropic-ai/claude-agent-sdk
clawboo restart
```

Then send the message or start the task again. A one-off `npx` run cannot load the SDK, so switch to the global install first. See [Claude Code](/runtimes/claude-code).

### The Hermes install fails with (from versions: none)

**What it means:** pip found no Hermes release for the Python it used. Hermes needs Python 3.11, 3.12 or 3.13. Clawboo picks the newest Python 3.11 or later that it finds, so a Python 3.14 wins over a 3.12 you also have, and the install fails.

**Fix:** install Hermes yourself with a supported Python, then click **Refresh** at the top of **Settings > Runtimes**:

```bash
pipx install --python python3.12 'hermes-agent[anthropic]<1'
```

**Prevent it:** keep a Python from 3.11 to 3.13 for Hermes. See [Hermes](/runtimes/hermes).

### More runtime messages

<AccordionGroup>

<Accordion title="Claude Code reads Needs key, but my claude CLI is signed in">

**What it means:** Claude Code agents in Clawboo need an Anthropic API key. The `claude` program's own sign-in does not count.

**Fix:** connect a key on the **Claude Code** row, or save one under **Settings > Providers**.

</Accordion>

<Accordion title="Codex reads Needs login after I signed in from a terminal">

**What it means:** the row has not checked again since you signed in.

**Fix:** click **Sign in** on the **Codex** row, then **Re-check**. A sign-in from any terminal on this computer counts.

</Accordion>

<Accordion title="Hermes needs Python 3.11 or newer, but the Python on this machine is 3.9">

**What it means:** the newest Python Clawboo found is too old, and pipx is not installed. On a Mac, Apple's own Python is often 3.9.

**Fix:** install a newer Python (for example `brew install python@3.12`) or pipx (`brew install pipx`), then click **Retry**. If Clawboo finds no Python at all, the message reads "Python 3.11+ (with pip or pipx) not found."; the fix is the same.

</Accordion>

<Accordion title="Permission denied. A global install may require elevated permissions.">

**What it means:** npm cannot write to its global folder while installing Claude Code or Codex. For OpenClaw the message reads "Permission denied. Your Node.js installation may require sudo for global installs."

**Fix:** use Node.js from a version manager (nvm or fnm) or from Homebrew, which install global packages without `sudo`, then click **Retry**. The message also names the `sudo` command if you prefer it.

</Accordion>

<Accordion title="Gateway did not become reachable within 60s">

**What it means:** the Gateway did not answer on its port within 60 seconds. When the Gateway's log names a reason, the message reads "Gateway did not start:" followed by it.

**Fix:** read the Gateway's log at `~/.clawboo/gateway.log`, fix what it reports, then click **Retry**. OpenClaw's [troubleshooting guide](https://docs.openclaw.ai/help/troubleshooting) covers its own errors.

</Accordion>

<Accordion title="OpenClaw needs openclaw doctor --fix, and running it failed">

**What it means:** OpenClaw wanted a one-time update to its data before starting, and the `openclaw doctor --fix` that Clawboo ran for it failed.

**Fix:** run `openclaw doctor --fix` in a terminal to see the whole report, then click **Retry** or **Reconnect OpenClaw**.

</Accordion>

<Accordion title="An action fails with gateway_disconnected">

**What it means:** the action needs the Gateway, for example creating an OpenClaw agent or saving its files, and Clawboo's server is not connected to it.

**Fix:** start the Gateway from **Settings > Runtimes > OpenClaw**, then try again. Agents on other runtimes do not need the Gateway.

</Accordion>

</AccordionGroup>

## Team chat and delegation

### An agent does not reply

**What it means:** the message reached no agent that could run, or the run is waiting on something.

**Fix:** check these in order.

1. **A notice in the chat.** When a run fails before the agent writes anything, the chat shows the reason. Look it up on this page.
2. **The runtime is connected.** In **Settings > Runtimes**, the agent's runtime reads **Connected**. An OpenClaw agent also needs the OpenClaw Gateway online.
3. **Needs you.** A command, an app call or a risky hand-off may be waiting for your answer on the **Board**.
4. **The agent is busy.** An agent works on one thing at a time, so new work waits until it is free. A waiting task stays in **To do**.
5. **A budget.** A budget in hard cap mode that reached its limit stops some runs; see [Budgets and costs](#budgets-and-costs).

If it still does not answer, go through [When an agent is not doing what you asked](#when-an-agent-is-not-doing-what-you-asked).

### No response from the delegate for 8 minutes.

**What it means:** a teammate took a hand-off and then reported nothing for 8 minutes, so Clawboo ended its run and failed the task. The leader is told. A teammate inside one long tool call, such as a build, gets 24 minutes: "The delegate has been inside one tool call for over 24 minutes with no result."

**Fix:** open the task in **Needs you** on the **Board** (it reads **Timed out**) and click **Retry**. If the teammate keeps timing out, check its runtime and model.

### The run ended without reporting a result.

**What it means:** the connection to the agent's runtime dropped before the run finished, so there is no reason to report. The notice goes on: "The connection to the runtime may have dropped; try sending again."

**Fix:** send the message again. If it happens every time, read the server log, and check the runtime in **Settings > Runtimes**.

### The agent ignored my file

**What it means:** either the agent's runtime does not read that agent file, or the agent could not reach a file on your computer.

**Fix:**

- **Agent files.** Only OpenClaw reads AGENTS.md, IDENTITY.md and TOOLS.md as instructions, and OpenClaw 2026.9 and later skips TOOLS.md, so put tool notes in AGENTS.md. On the other runtimes the agent follows SOUL.md: all of it on Clawboo Native, the first 4,000 characters on Claude Code, Codex and Hermes. See [Edit the agent files](/using/agents#edit-the-agent-files).
- **Files on your computer.** In team chat, a Clawboo Native agent can open files only in its team's folder (`~/.clawboo/workspaces/<team id>`). Claude Code, Codex and Hermes agents start in that folder too, so give them the file's full path. They can reach any file your user account can; see [What agents can do](/concepts/permissions).

### More chat messages

<AccordionGroup>

<Accordion title="The message box is greyed out">

**What it means:** while agents work, **Stop** replaces the send button. The box also stays off when the chat has no agents, for example a room whose members all left the team.

**Fix:** press **Stop**, or wait for the work to finish. In a room, add members with **Edit room members**. See [Team chat](/using/team-chat).

</Accordion>

<Accordion title="Could not reach the team right now. Please try again in a moment.">

**What it means:** your message could not be delivered to the team, for a reason other than the OpenClaw Gateway.

**Fix:** send it again in a moment. If it keeps happening, read the server log.

</Accordion>

<Accordion title="Delegation to Ada not approved (expired); skipped.">

**What it means:** the leader handed off work to a teammate (here, Ada) in words that looked risky, such as delete, deploy or secret, so Clawboo asked you first. Nobody answered within 5 minutes, so the team skipped that hand-off. If you clicked **Don't allow**, the message reads "(deny)" instead.

**Fix:** answer risky hand-offs in **Needs you** on the **Board**, then ask the team again. See [Approvals](/using/approvals).

</Accordion>

<Accordion title="My @ mention went to the leader instead">

**What it means:** a mention picks the agent only at the very start of the message, followed by a space. In a room, only the room's members can be mentioned.

**Fix:** start the message with `@Name `. To reach an agent outside the room, add it to the room or talk to it in General.

</Accordion>

<Accordion title="Gateway not connected… in an agent's own chat">

**What it means:** the chat on an agent's page works with Clawboo Native agents, and with OpenClaw agents while the Gateway is connected. Claude Code, Codex and Hermes agents take their work from team chat and the board.

**Fix:** for an OpenClaw agent, connect the Gateway in **Settings > Runtimes**. For the other runtimes, give the agent work in its team's chat or on the **Board**.

</Accordion>

<Accordion title="This run stopped because the runtime believed it was out of context room.">

**What it means:** the runtime decided the conversation was too big for the model. That usually comes from a wrong context-window setting, or a long list of connector tools, rather than a long conversation.

**Fix:** check the model's real context window in **Settings > Runtimes**, and give the agent fewer connectors. Starting the conversation fresh does not fix the cause.

</Accordion>

<Accordion title="The run failed: the run went quiet for too long and was ended">

**What it means:** the agent's run sent nothing for 30 minutes, so Clawboo ended it.

**Fix:** send the message again. If the agent was working on something slow, split the job into smaller steps.

</Accordion>

</AccordionGroup>

## The board and tasks

### A task waits in Needs you

**What it means:** the task will not move by itself. Its badge says why:

| Badge            | What happened                                          |
| ---------------- | ------------------------------------------------------ |
| **Failed**       | The last run ended in an error                         |
| **Timed out**    | The agent stopped responding and its run was ended     |
| **Stopped**      | You pressed **Stop**; it never restarts by itself      |
| **Needs review** | Its work did not pass the check                        |
| **Blocked**      | An agent marked it blocked                             |
| **Unassigned**   | No agent is bound to it                                |
| **Not started**  | It is in In progress with no agent, so no run is going |

**Fix:** read the reason on the card, then click its button: **Retry** runs it again, **Assign** gives it to an agent, and **Review** or **Open** opens the task. The card's **More** menu (the three dots) holds the other choices, including **Dismiss** to cancel it. If the agent asked you something, answer it in the task's reply box instead: a reply to a task in **Needs you** that has an agent starts the agent on it again. See [Things that need you](/using/board#things-that-need-you).

**Prevent it:** after three failed runs in a row, Clawboo stops retrying a task by itself, so a task that keeps failing usually has a setup problem. Fix the cause before you click **Retry**.

### A task reached Done with no check mark

**What it means:** this is normal for most tasks. Clawboo checks work only on a task run that worked in its own git worktree and changed files, and only the API starts those runs. Work handed off in team chat, tasks you start on the **Board** and all OpenClaw work reach **Done** without a check.

**Fix:** review the result yourself. See [How work is checked](/concepts/verification).

### More board messages

<AccordionGroup>

<Accordion title="A task has been In progress for a long time">

**What it means:** the agent may still be working, or its run may have stopped reporting. Clawboo ends a run that stays silent too long and releases its task, which then runs again or waits in **Needs you** as **Timed out**.

**Fix:** reply on the task to steer it ([Steer a running task](/using/board#steer-a-running-task)), or press **Stop** in its team's chat. The exact waits are in [Limits and defaults](/reference/limits-and-defaults).

</Accordion>

<Accordion title="A reply says Not sent">

**What it means:** the note under your reply says why it did not reach an agent. The reply itself is saved on the task.

- "Not sent: the task is finished": the task is **Done** or **Cancelled** and cannot run again. Click **Send as a follow-up task** to give the same agent a new task with your reply as its brief.
- "Not sent: no agent has this task": nobody is bound to the task. Give it to an agent with **Assign** in **Needs you**, then reply again.
- "Not sent: something went wrong": Clawboo saved the reply but could not deliver it, for example because the database was busy. Send it again, or click **Retry** on the task.

</Accordion>

<Accordion title="I cannot move a card to In progress">

**What it means:** only an agent's run puts a task in progress, so the board does not offer that move.

**Fix:** move the task to **To do** with an agent bound to it, or use **Retry** or **Assign** in **Needs you**.

</Accordion>

<Accordion title="This task changes files, so it needs an isolated git worktree, but no repository path was provided for it.">

**What it means:** a run started through the API was for a task that changes files, and named no repository. The task comment starts with `[blocked: no isolation]`, and the task goes back to **To do**.

**Fix:** pass a `repoPath` that points to a git repository, or start the task as a research or review task. See [Worktrees and handoff](/concepts/worktrees-and-handoff).

</Accordion>

<Accordion title="Couldn’t load the board.">

**What it means:** the board's first read failed, usually because the Clawboo server is not answering.

**Fix:** click **Retry**. If it keeps failing, go back to [First 60 seconds](#first-60-seconds).

</Accordion>

</AccordionGroup>

## Budgets and costs

### Auto-paused: team budget reached. Raise the cap (or resume) to continue.

**What it means:** a budget in hard cap mode reached its limit, so Clawboo stopped the run, sent the task back to **To do** and left this comment. The word before "budget" names the budget that ran out: agent, team, or mission (a task plus everything handed off from it). "node" means a per-run limit, which only a routine set up through the API can carry. In team chat the stopped run's task fails instead, and the chat can show "The run failed: the run was stopped by a budget cap".

**Fix:** open **Settings > Insights > Governance**. The budget reads **paused**: click **Resume**, or raise its limit with **Set cap**. If spend is still over the limit, a resumed budget pauses again at the next charge, so raise the limit to keep working. See [Resume or raise a budget](/using/budgets-and-spend#resume-or-raise-a-budget).

### My hard cap did not stop the team

**What it means:** in team chat, nothing checks a budget before a turn starts. Only a Clawboo Native run on a priced model reports cost while it works, so only that run stops partway. Every other run is charged when it finishes, and the next team-chat turn still runs.

**Fix:** press **Stop** in the team's chat to halt it right away. [What a hard cap stops](/concepts/governance#what-a-hard-cap-stops) explains what a cap can stop on each path, and [Budgets and spend](/using/budgets-and-spend) shows how to watch spend.

### A cost reads est., or a local model shows a cost

**What it means:** "est." (a `~` before the amount on a card) marks an estimate: the runtime reported no charge, so Clawboo priced the run itself. Models Clawboo has no price for, including every local Ollama model, are estimated at $3 per million input tokens and $15 per million output tokens. An Ollama run costs you nothing.

**Fix:** nothing to fix. [Budgets and spend](/using/budgets-and-spend) lists what each runtime reports and what counts toward a budget.

### More budget messages

<AccordionGroup>

<Accordion title="Tokens Used shows zero for my agents">

**What it means:** **Tokens Used** counts OpenClaw agents only. Clawboo Native, Claude Code, Codex and Hermes agents show zero there, however much they worked.

**Fix:** see their cost on each task's card and, once you add a budget, on its row in **Settings > Insights > Governance**. A Hermes agent's routine and API runs record no cost and do not count toward budgets; check those in your provider's own dashboard.

</Accordion>

<Accordion title="Budget cap reached">

**What it means:** an OpenClaw agent's routine run went over a hard cap. The run is recorded, and the routine's next run is refused.

**Fix:** raise the cap, or **Resume** the budget, in **Settings > Insights > Governance**.

</Accordion>

</AccordionGroup>

## Self-hosting and remote access

<Warning>

On clawboo 0.5.0 and older, a reverse proxy on the same machine leaves every `/api/mcp/` path open, even with an access token set. Deny all of `/api/mcp/` at the proxy, or upgrade once a release newer than 0.5.0 is out. [Security model](/operating/security) has the rules for nginx, Caddy and Cloudflare Tunnel.

</Warning>

### Cross-origin request blocked.

**What it means:** every action in the dashboard fails with a 403, because Clawboo's same-origin guard does not recognize the address in the request. That happens when you reach Clawboo by a name or port it was not told about, for example through a reverse proxy.

**Fix:** set `CLAWBOO_ALLOWED_HOSTS` to the host name you use and `CLAWBOO_ALLOWED_ORIGINS` to the full origin (scheme, host and any port), then restart the server. Through an SSH tunnel, use the same port on both ends. See [Reach Clawboo from another machine](/guides/self-host-securely).

### Too many requests. Wait a moment and retry.

**What it means:** one address sent more requests to Clawboo's API in a minute than its limit allows (a 429). Routes that install software, change runtime settings or grant access have a lower limit and say "Too many requests for this operation. Wait a moment and retry." Page loads and dashboard files have an allowance of their own.

**Fix:** wait a minute, then try again. The usual cause is a script or tool calling the API in a tight loop, or a page that keeps reloading: stop it. Behind a reverse proxy every request arrives from the same address, so all your browsers and tools share one allowance. The limits are in [Limits and defaults](/reference/limits-and-defaults#network-and-http).

### Clawboo access token required

**What it means:** the server runs with `STUDIO_ACCESS_TOKEN`, and this browser has no access cookie yet (a 401). "Invalid Clawboo access token." means the token in the address does not match the server's.

**Fix:** open your Clawboo address once with `?access_token=<your token>` added. Check the token for missing or extra characters.

### SECURITY: refusing to start

**What it means:** `HOST` makes the server listen on a network address, and it has no working access token, so it exits rather than serve everyone on your network.

**Fix:** set `STUDIO_ACCESS_TOKEN` (letters, digits, `.`, `_`, `~` and `-` only), or unset `HOST` to listen on this computer only. To create a token, run `openssl rand -hex 24`.

### Agents lost their Clawboo tools after setting HOST

**What it means:** `HOST` names a single network address, so the server stops answering on `127.0.0.1`, the address Clawboo's own agents use to reach its tools. Their calls to the board, memory and team chat fail.

**Fix:** use `HOST=0.0.0.0`, which answers on every address including `127.0.0.1`, or keep the default and reach Clawboo through an SSH tunnel. Either way, set an access token. See [Reach Clawboo from another machine](/guides/self-host-securely).

### More remote-access messages

<AccordionGroup>

<Accordion title="STUDIO_ACCESS_TOKEN contains an unsupported character">

**What it means:** the token uses a character other than letters, digits, `.`, `_`, `~` and `-`, so the server turned the token check off. On a network address the server refuses to start; behind a reverse proxy on the same machine, everything is open.

**Fix:** make a new token with `openssl rand -hex 24`, restart the server with it, and sign in again.

</Accordion>

<Accordion title="SECURITY: a request reached this server through a reverse proxy">

**What it means:** a request came through a proxy and the server has no access token, so anyone who can reach the proxy can use the dashboard and the API. The warning appears once per server start and never blocks a request.

**Fix:** set `STUDIO_ACCESS_TOKEN` and restart, unless the proxy itself checks every request.

</Accordion>

<Accordion title="Not found. This Clawboo is served under /clawboo/">

**What it means:** the server runs under a path prefix (`CLAWBOO_BASE_PATH`), and the address you opened is outside it. The message names the prefix.

**Fix:** open the address with the prefix, for example `http://localhost:18790/clawboo/`.

</Accordion>

<Accordion title="clawboo stop says the server requires an access token">

**What it means:** the command cannot stop a server protected by an access token.

**Fix:** stop it with Ctrl+C in its terminal, with your service manager, or with the command that `clawboo stop` prints. See [Token-gated installs](/reference/cli#token-gated-installs).

</Accordion>

</AccordionGroup>

## When an agent is not doing what you asked

Work through these causes in order. The first ones are the most common.

1. **The wrong runtime or model.** On the agent's page, the **Graph** card shows the model, beside the runtime's icon. Pick another model where the runtime lets you ([Change the model](/using/agents#change-the-model)). An agent cannot move to another runtime, so create a new one on the runtime you want. Also check who got the message. An @mention picks an agent only at the very start of the message; otherwise the team's leader answers and decides whether to hand the work on.
2. **No provider, or not the one the agent uses.** A Clawboo Native agent's page header reads **Disconnected** or **No provider key** when it has no provider it can use; click **Set up in Runtimes**. For the other runtimes, check that the runtime's row in **Settings > Runtimes** reads **Connected**.
3. **The model cannot use tools.** Agents hand off work, use the board and reach apps through tools. A model without them fails with "can't use tools, and this agent needs them", and the model list marks such Ollama models **(can't use tools)**. Pick a model that can.
4. **The agent never read your file.** Which agent files count depends on the runtime, and agents in team chat cannot always reach files on your computer. See [The agent ignored my file](#the-agent-ignored-my-file).
5. **The connector is not shared with that agent.** Connecting an app makes it available, but gives no agent access. Give it to the agent on the Org chart, a team graph or the agent's **Graph** card. See [Give a connector to an agent](/using/connectors#give-a-connector-to-an-agent).
6. **An approval is waiting.** A command, an app call or a risky hand-off can wait for your answer in **Needs you** on the **Board**. An unanswered risky hand-off is skipped after 5 minutes. See [Approvals](/using/approvals).
7. **A budget paused the work.** In **Settings > Insights > Governance**, a hard cap budget that reached its limit reads **paused**. Click **Resume**, or raise the limit with **Set cap**. See [Budgets and spend](/using/budgets-and-spend).
8. **The task is blocked.** A task in **Needs you** says why it stopped. Read the reason on its card, then use its button (**Retry**, **Assign**, **Review** or **Open**), or pick **Dismiss** from the card's **More** menu. See [A task waits in Needs you](#a-task-waits-in-needs-you).

## Report a bug

<Steps>

<Step title="Search first">

Look through the [open issues](https://github.com/clawboo/clawboo/issues) for your problem. For questions and ideas, use [Discussions](https://github.com/clawboo/clawboo/discussions).

</Step>

<Step title="Pick a template">

Open a [new issue](https://github.com/clawboo/clawboo/issues/new/choose) and choose the template that fits:

| Template                      | Use it for                                              |
| ----------------------------- | ------------------------------------------------------- |
| **Bug Report**                | Something is broken                                     |
| **Setup & install help**      | `clawboo` will not start, or a runtime will not connect |
| **Documentation issue**       | A page in these docs is wrong, missing or unclear       |
| **Feature Request**           | An improvement or a new feature                         |
| **Runtime / adapter request** | Support for another agent runtime                       |

</Step>

<Step title="Say what happened">

Include:

- Your Clawboo version (`clawboo --version`), Node.js version (`node -v`) and operating system.
- The runtime and model of each agent involved.
- What you did, what you expected and what happened, as steps someone else can repeat.
- The exact message you saw, and the last lines of `~/.clawboo/server.log`.
- Any check in **System Health** that does not read **OK**.
- For an OpenClaw problem, the OpenClaw version (shown in **Settings > System**, or run `openclaw --version`) and the last lines of `~/.clawboo/gateway.log`.

</Step>

<Step title="Remove secrets before you post">

Take out:

- Provider keys. They start with `sk-`, `sk-ant-`, `sk-or-` and similar.
- Your `STUDIO_ACCESS_TOKEN`, and any address containing `access_token=`.
- MCP attach URLs, which carry signatures, and the OpenClaw Gateway token.
- Anything copied from `~/.openclaw/.env` or `~/.clawboo/secrets`.

Clawboo's logger masks values that look like keys, but not everything in the log goes through it, so read what you paste.

</Step>

</Steps>

To report a security vulnerability, do not open a public issue. Report it privately, as the [security policy](https://github.com/clawboo/clawboo/security/policy) describes: on the repository's **Security** tab, choose **Report a vulnerability**.

## Related

- [FAQ](/appendices/faq): short answers to common questions.
- [Known issues](/appendices/known-issues): limitations we know about.
- [Providers and runtimes](/using/providers-and-runtimes): connect keys, sign-ins and runtimes.
- [Limits and defaults](/reference/limits-and-defaults): every timeout and limit.
- [CLI reference](/reference/cli): every `clawboo` command and what it prints.
- [Data and state](/operating/data-and-state): where files live, backup and reset.
