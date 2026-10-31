---
title: 'Control which commands agents can run'
sidebarTitle: 'Command permissions'
description: 'Let a Clawboo Native agent ask to run commands, choose when an OpenClaw agent asks, and review or revoke what it may run without asking.'
keywords:
  [
    'command permissions',
    'exec allowlist',
    'standing permissions',
    'standing grants',
    'Command Execution',
    'Execution Permissions',
    'Run Freely',
    'Ask for Unknown',
    'Always Ask',
    'run_command',
    'shell commands',
    'revoke',
  ]
---

Two runtimes let you decide, from Clawboo, whether an agent may run shell commands on your computer: Clawboo Native and OpenClaw. Use this page to turn commands on or off for an agent, choose when it asks you first, and take back a permission you gave with **Always**.

| Runtime                    | Out of the box                                        | What you control here                                                   |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Clawboo Native             | Runs no commands                                      | A switch that lets the agent ask before each command                    |
| OpenClaw                   | **Ask for Unknown**, for agents you create in Clawboo | When the agent asks, and the list of commands it may run without asking |
| Claude Code, Codex, Hermes | Runs any command without asking                       | Nothing: Clawboo runs them with their own approval prompts turned off   |

[What agents can do](/concepts/permissions) explains what each runtime can reach. When an agent asks, the request appears as an approval card; [Approvals](/using/approvals) covers the cards.

## Before you begin

- Open the agent's page: click its Boo in the sidebar, or right-click it on the Org chart and choose **Open agent** (see [Agents](/using/agents)).
- In the **Details** card, choose **Permissions**. It appears only for Clawboo Native and OpenClaw agents.

## Let a Clawboo Native agent ask to run commands

<Steps>

<Step title="Open the setting">

On the agent's page, choose **Details** > **Permissions**. You see **Running commands**.

</Step>

<Step title="Turn it on">

Switch on **Let this Boo ask to run commands**.

</Step>

<Step title="Confirm">

In the dialog **Let this Boo ask to run commands?**, press **Allow it to ask**.

You should see **Saved**, and a note under the switch saying that commands run in the agent's working folder, as you, with access to the network.

</Step>

</Steps>

To stop it, switch it off. Runs that start after the change follow it.

With the switch on:

- **Every command asks first.** Nothing is remembered and there is no **Always**, so a command you allowed asks again the next time.
- **Only runs with a working folder can ask.** Team chat, tasks you start from the Board and routines made in the dashboard work in the team's folder. A run inside a git repository, which you set up through the API, works in its worktree. One-to-one chat has no working folder, so the agent never asks there.
- **Never on Windows.** The switch is there, but Clawboo does not offer the agent a way to run commands.
- **One program at a time.** A command is a program and its arguments, run without a shell, so pipes and redirects do not work. Programs that run other commands, such as shells, `python`, `node` and `npx`, are refused before you are asked; [What agents can do](/concepts/permissions#clawboo-native) lists them.
- **At most 10 commands per run.** Each card waits 10 minutes, and the run waits with it.
- **A refusal ends the asking.** After you choose **Don't allow**, or a card runs out of time, the agent cannot ask about another command for the rest of that run.
- **The approved program runs, or nothing does.** If the program changes on disk while the card waits, Clawboo does not run it.

<Warning>

An approved command runs on this computer as your user account, with network access, in the agent's working folder. The list of refused programs is a speed bump, not a boundary: ordinary programs such as `git` or `find` can still start others. Approve only commands you understand.

</Warning>

## Choose when an OpenClaw agent asks

On the agent's page, **Details** > **Permissions** shows **Execution Permissions** with a **Command Execution** dropdown. The line under the dropdown describes the option you picked.

| Option              | The line under it                   | What happens                                                                     |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| **Run Freely**      | Executes commands without asking    | No card. The agent runs what it decides to run                                   |
| **Ask for Unknown** | Asks approval for unlisted commands | A command that is not on the agent's list raises an approval card                |
| **Always Ask**      | Asks approval for every command     | Every command raises a card, and the Gateway never remembers one with **Always** |

Pick an option and you should see **Execution permissions updated**. The agent follows it from its next message.

- **The starting point.** An agent you create in Clawboo starts on **Ask for Unknown**. For an agent created in OpenClaw itself, the dropdown shows **Run Freely** until you pick an option, because Clawboo has no setting stored for it.
- **Clawboo applies the change at the OpenClaw Gateway.** If the Gateway refuses it, for example while Clawboo is not connected to it, a message starting **Not applied.** appears and the dropdown goes back. Clawboo still keeps your choice in its own record, so after a reload the dropdown can show an option the Gateway is not using. Pick it again once the Gateway is connected.
- **Changing the option keeps the list.** Commands the agent may run without asking stay on file whichever option you pick. To remove one, revoke it (below).
- **A separate default.** The **Command Approval** card under **Settings** > **System** holds a default in OpenClaw's own config; see [System](/using/system).

## See what an OpenClaw agent may run without asking

Below the dropdown, **Commands this Boo can run without asking** lists the agent's standing permissions. Each one comes from an **Always** you gave on a command card, or from OpenClaw's own settings. A row names the program and says how wide the permission is:

| What the row says                       | What the agent may run without asking                                          |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| One exact command, in one exact folder  | That command, typed the same way, in that folder. **Always** creates this kind |
| One exact command                       | That command, in any folder                                                    |
| This program, matching arguments        | That program, when its arguments match a pattern                               |
| This program, any arguments, any folder | Anything that program can do. The row has a **Broad** pill                     |
| Any command at all                      | Anything. The row has a **Broad** pill                                         |
| Part of another grant on this computer  | Nothing by itself: it is one half of another permission                        |
| Kept on file, but OpenClaw skips it     | Nothing. The row has a **Not in effect** pill                                  |

A few rows carry more:

- **and its companion rule**: one **Always** wrote two rules, and Clawboo shows them as one permission. It groups them only when the agent has exactly one of each; otherwise the companion shows as its own row with **Not removable here**.
- On the narrowest kind: "clawboo cannot show which command: OpenClaw keeps only a fingerprint of it and the folder it ran in. The same command typed differently, or run elsewhere, asks again."
- "Also granted to every Boo. Removing it here would not stop it." Its revoke button is turned off.

When some permissions apply to every agent, a footer says how many and that they "are set outside clawboo and cannot be changed here."

The list does not update by itself. It is read when you open **Permissions**, after a revoke, and when you press the **Refresh** icon beside the heading, so press it after answering **Always**.

## Revoke a permission

<Steps>

<Step title="Pick the row">

Click the trash icon on the permission's row.

</Step>

<Step title="Confirm">

The dialog **Revoke this standing permission?** says the command will need your approval again the next time this agent runs it. For a grouped row, both rules go together. A command already approved and waiting to run may fail, because OpenClaw checks the whole rule set again before it starts. Press **Revoke**.

</Step>

<Step title="Check the result">

You should see **Standing permission revoked**, and the row is gone. Clawboo reads the list again before it reports, so a row that is still there is still in force.

</Step>

</Steps>

Reading the list needs only Clawboo: it opens OpenClaw's own state database on this computer, read-only. Revoking goes through the Gateway, so Clawboo's server must be connected to it. To give a permission back, answer **Always** on the next card for that command; Clawboo cannot add or edit a permission directly.

## When the list says No standing permissions

The empty list comes in two versions, and they mean different things:

| The line under **No standing permissions**                                 | What it means                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| When you answer Always to a command prompt, what you allowed appears here. | Clawboo read OpenClaw's permissions, and this agent has none |
| Nothing on this computer has been granted a standing exec permission yet.  | Clawboo found no OpenClaw permissions where it looks         |

Treat the second version with care. It is also what you see when the OpenClaw Gateway runs on another computer, or keeps its data in a folder Clawboo is not reading. In both cases the agent can have permissions this list cannot show.

A red alert is different again. It starts **clawboo could not read this computer's permission list** and ends "Nothing here is safe to trust until it can be read again." Clawboo found the permissions but could not read them, or its server did not answer. The permissions on file still apply. Press **Refresh**; if the alert stays, check the permissions in OpenClaw itself.

<Accordion title="Where Clawboo reads the list">

Clawboo opens `state/openclaw.sqlite` inside OpenClaw's state folder, read-only. The folder is the first of:

1. `OPENCLAW_STATE_DIR`, `MOLTBOT_STATE_DIR` or `CLAWDBOT_STATE_DIR`, when set in the environment Clawboo starts in
2. `~/.openclaw`, when it exists
3. `~/.clawdbot` or `~/.moltbot`, when one of them exists

If your OpenClaw keeps its state somewhere else, set `OPENCLAW_STATE_DIR` for Clawboo too. See [Data and state](/operating/data-and-state) for the other files Clawboo reads in OpenClaw's folder.

</Accordion>

## Limits

- **Same computer only.** The list reads OpenClaw's files directly, so it works only when the Gateway runs on the same computer as Clawboo.
- **This agent only.** Permissions that apply to every agent show only as the footer count, and you change them in OpenClaw.
- **Revoke only.** You cannot create, edit or narrow a permission here. **Always** on a command card is how Clawboo adds one.
- **No live updates.** A permission you add by answering **Always** appears after you press **Refresh**.

## Troubleshooting

<AccordionGroup>

<Accordion title="The switch is on, but my Clawboo Native agent never asks">

The agent can ask only on a run with a working folder, and never on Windows. One-to-one chat has no working folder, so the agent has no way to run a command there. Team chat, Board tasks and routines made in the dashboard work in the team's folder, so the agent can ask there.

</Accordion>

<Accordion title="Not applied. saved in clawboo, but the Gateway did not accept it">

The Gateway refused the new **Command Execution** option, or Clawboo is not connected to it. The agent keeps its old setting. Check OpenClaw under **Settings** > **Workspace** > **Runtimes**, then pick the option again.

</Accordion>

<Accordion title="The revoke button is greyed out">

Either the permission is also granted to every agent (the row says "Also granted to every Boo"), which you change in OpenClaw, or a revoke is still in progress.

</Accordion>

<Accordion title="the Gateway accepted the change and still lists those grants">

Clawboo sent the revoke, and the Gateway's reply still contains the permission. Press **Refresh**. If the row is still there, the permission is still in force; try the revoke again.

</Accordion>

<Accordion title="that grant is set for every Boo, not just this one, so it cannot be removed here">

The permission is in the set that applies to every agent, so removing it from this agent would not stop it. Change it in OpenClaw.

</Accordion>

<Accordion title="those grants were already gone">

Someone or something removed the permission before your revoke landed. Press **Refresh** to see the current list.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- **Clawboo Native.** `GET` and `POST /api/agents/:agentId/shell` (body `{ "enabled": true }`) read and set the switch, stored as `tools.shell` in the agent's config. A missing value means off, and the route answers 400 for other runtimes. The tool exists only on runs with a working folder, never on Windows, and a run can ask at most 10 times.
- **OpenClaw setting.** `POST /api/exec-settings` saves Clawboo's record, then writes the agent's entry in the Gateway's approvals policy under OpenClaw's own agent id, with the values `off`, `on-miss` and `always`. A refusal answers 502 with `savedLocally: true`. **Run Freely** removes the agent's ask setting but keeps its list.
- **The list.** `GET /api/exec-allowlist?agentId=<id>` answers `ok` or `absent` (200), `not-applicable` for other runtimes, or `unreadable` (502, with the last known rule count).
- **Revoke.** `POST /api/exec-allowlist/revoke` with `{ "agentId": "<id>", "keys": [...] }`. Clawboo rewrites OpenClaw's whole permissions document and checks the Gateway's reply before it answers: 200 `revoked`; 409 `already-absent`, `blocked-wildcard` or `no-such-agent`; 502 `not-verified`.

</Accordion>

## Next steps

- [Approvals](/using/approvals): answer the cards these settings raise.
- [What agents can do](/concepts/permissions): what each runtime can reach, with and without asking.
- [Agents](/using/agents): the agent page and its **Details** card.
- [OpenClaw](/runtimes/openclaw): set up and manage the OpenClaw Gateway.
- [System](/using/system): the default **Command Approval** for OpenClaw agents.
