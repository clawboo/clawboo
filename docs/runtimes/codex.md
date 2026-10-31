---
title: 'Codex runtime'
sidebarTitle: 'Codex'
description: 'Run agents on OpenAI Codex with your ChatGPT plan: install it, sign in, and see what it can do on your computer and how Clawboo estimates its cost.'
keywords:
  [
    'codex',
    'ChatGPT subscription',
    'Sign in with ChatGPT',
    'codex login',
    'CODEX_HOME',
    'codex app-server',
  ]
---

Codex is OpenAI's coding agent. You sign in with your ChatGPT account instead of pasting an API key, so Codex is how you run agents on a ChatGPT plan. A Codex agent works with Codex's own tools: it runs shell commands, edits files and searches the web. Use this page to set it up, see what Clawboo controls on it, and understand what it can do on your computer.

| Topic           | Codex                                                |
| --------------- | ---------------------------------------------------- |
| Best for        | Running a team on your ChatGPT plan, with no API key |
| You need        | A ChatGPT account whose plan includes Codex          |
| Who bills you   | OpenAI, through your ChatGPT plan                    |
| Cost in Clawboo | An estimate from the tokens Codex reports            |
| Steering        | Your comments reach a running task                   |

If you chose **Sign in with ChatGPT** during onboarding, you already installed Codex, signed in and deployed your first team on it. To compare Codex with the other runtimes, see [Choose a runtime](/runtimes/index).

## Before you begin

- Clawboo running, and Node.js with npm (Clawboo installs Codex with npm).
- A ChatGPT account whose plan includes Codex. Clawboo never sees your password: Codex's own sign-in opens OpenAI's page in your browser.

## Set up Codex

<Steps>

<Step title="Install Codex">

Open **Settings** (at the bottom of the left sidebar, or press Cmd+, on macOS and Ctrl+, on Windows or Linux), then **Runtimes**. On the **Codex** row, click **Install**, then **Install** in the panel that opens. Clawboo runs this and shows its output:

```bash
npm install -g @openai/codex@0
```

You should see the row change to **Needs login**. If Codex is already installed and signed in on this computer, the row reads **Connected** straight away.

</Step>

<Step title="Sign in with ChatGPT">

Click **Sign in** on the row, then **Sign in with ChatGPT**. Clawboo runs Codex's own `codex login`, which opens OpenAI's sign-in page in your browser. Approve there; there is no code to type. If no browser window appears, click **Open sign-in page**.

You should see the row read **Connected**. The same sign-in is on **Settings** > **Providers** > **ChatGPT subscription** > **Connect**.

</Step>

<Step title="Put Codex agents on a team">

Create a team, and in **Customize team** set a member's runtime to **Codex**, then deploy the team. You can pick Codex there only while its row reads **Connected**; until then it is greyed out with "Connect in Runtimes". See [Teams](/using/teams) for the full flow.

</Step>

</Steps>

If the in-app sign-in fails, the panel shows the reason and the command to run yourself. Run `codex login` in a terminal, finish in the browser, then click **Re-check** in the Codex panel.

## What Clawboo controls on Codex

| What              | On Codex                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona           | The agent's `SOUL.md` (which the Personality sliders write into) is added to every prompt as a persona block, up to 4,000 characters.                                                             |
| `AGENTS.md`       | Draws the agent's links on the team graph. Codex never reads it.                                                                                                                                  |
| Other agent files | Not used. See [Agents](/using/agents).                                                                                                                                                            |
| Model             | Team setup has no model picker for Codex. It runs Codex's default model.                                                                                                                          |
| Codex home        | Each Codex agent has its own Codex folder (below). Your own `~/.codex` settings are not used.                                                                                                     |
| Clawboo tools     | Every run gets Clawboo's Tasks, Memory, Tools and TeamChat servers (MCP).                                                                                                                         |
| Leading a team    | A Codex leader hands work to teammates with the `team_delegate` tool.                                                                                                                             |
| Worktree          | Only a task-runner run that names a repository gets its own git worktree. Team chat and the tasks a team hands out run without one. See [Worktrees and handoff](/concepts/worktrees-and-handoff). |
| Steering          | Live. A comment on a running task joins the turn in progress; Codex reads it at its next model call, after the command that is running. See [Board](/using/board).                                |
| Sessions          | A Codex agent leading a chat continues the same Codex thread from one turn to the next, separately for each chat room. Its one-to-one chat continues one session until `/reset`.                  |
| Memory            | Clawboo's shared memory, through the Memory tools, plus the thread history in the agent's Codex folder.                                                                                           |
| Cost              | An estimate from the tokens Codex reports. See [Costs](#costs).                                                                                                                                   |

### Each agent's Codex folder

Each Codex agent gets its own Codex home at `~/.clawboo/runtimes/codex/<agent id>`, created so only your user can open it. Codex keeps the agent's sessions there, which is how a leader, or the agent's own chat, continues its thread. Before each run, Clawboo:

- copies your ChatGPT sign-in (`~/.codex/auth.json`) into the folder when the copy there is missing, unusable or older than yours. Codex refreshes the copy itself, so Clawboo never overwrites a newer one.
- writes the folder's `config.toml`, which lists Clawboo's MCP servers. Your own `~/.codex/config.toml` is not read, and Clawboo never writes to `~/.codex`.

### Leading a team on Codex

When onboarding deploys your first team on Codex (the **Sign in with ChatGPT** path), it gives the team a lead: the member with a leader role, or else its first agent. It also promotes that agent to Boo Zero, the leader that coordinates every team. It skips that promotion when you already chose a Boo Zero or have a Clawboo Native one; an OpenClaw Gateway's default agent is replaced. See [Boo Zero](/using/boo-zero).

## Permissions and safety

<Warning>

Clawboo runs Codex with its own sandbox and approval prompts turned off (approval policy `never` and sandbox `danger-full-access`, or `--dangerously-bypass-approvals-and-sandbox` when a run falls back to `codex exec`). Nothing asks you before it runs a command, edits or deletes a file, or reaches the network. It runs as your user account and can read and change any file that account can.

</Warning>

- **A worktree is not a sandbox.** Only a task-runner run of a task that changes files, with a repository named, works in its own git worktree, which keeps its edits off your main checkout. Everywhere else there is no worktree: in team chat, in the agent's own chat, and on research and review runs (which includes every agent Routine you create in the app), Codex starts in its team's folder, `~/.clawboo/workspaces/<team id>`, which every member of the team shares (a task or an agent with no team uses `workspaces/_no-team`). That folder only sets where it starts: Codex can still read and change any file your user account can, including Clawboo's database and key vault.
- **Clawboo's approvals do not cover Codex's own tools.** Calls the agent makes through Clawboo's Tools server (connectors, for example) go through Clawboo's checks and can ask you first. Codex's shell commands, file edits and web searches never do. If Codex asks for an approval or an answer mid-run, Clawboo declines, so the run never waits for a person who is not there.
- **Clawboo hides some secrets from it, by name only.** Before a run, Clawboo removes its own secrets and a fixed list of common credentials (GitHub, npm, cloud, Stripe, Slack and database variables) from the environment Codex inherits. Other variables pass through, and credential files on disk stay readable.

For work you do not trust, run Clawboo under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) compares every runtime.

## Costs

Codex reports the tokens a run used but no dollar figure, and Clawboo has no price list for Codex models. Clawboo prices the tokens at its default estimate rate ($3 per million input tokens, $15 per million output tokens), records the result as an estimate, and counts it toward your budgets.

On a ChatGPT plan you are not billed per token: the estimate is a guide for your budgets, not your bill. See [Budgets and spend](/using/budgets-and-spend) for how each runtime's cost reaches your budgets.

## Sign out

In **Settings** > **Runtimes**, click **Manage** on the **Codex** row, then **Sign out** and confirm. Clawboo runs Codex's own `codex logout`, and the row then reads **Needs login**. Codex keeps no key in Clawboo's vault, so there is nothing else for Clawboo to delete.

## Limits

- Team setup has no model picker for Codex members.
- Your own `~/.codex` settings do not apply to Codex agents.
- A Codex too old to run `codex app-server` falls back to `codex exec`, which cannot take comments mid-run.
- Its cost in Clawboo is always an estimate.

## Troubleshooting

<AccordionGroup>

<Accordion title="Codex reads Needs login after I signed in from a terminal">

Click **Sign in** on the **Codex** row to open its panel, then **Re-check**. Clawboo asks Codex (`codex login status`) whether you are signed in, so a sign-in from any terminal on this computer counts.

</Accordion>

<Accordion title="The codex CLI isn't installed yet. Install it first, then sign in.">

You started **Sign in with ChatGPT** (for example on **Settings** > **Providers**) before Codex was installed. Install it from **Settings** > **Runtimes** > **Codex** > **Install**, then sign in again.

</Accordion>

<Accordion title="Sign-in timed out. Try again.">

The browser sign-in was not finished within about 15 minutes. Click **Retry**, or run `codex login` in a terminal and click **Re-check**.

</Accordion>

<Accordion title="Sign-in did not complete (exit 1). Run codex login in your terminal, then re-check.">

Codex's sign-in stopped with an error (the exit number can differ). Run `codex login` in a terminal to see Codex's own message, finish the sign-in there, then click **Re-check**.

</Accordion>

<Accordion title="A run fails with no Codex credentials provisioned for managed home">

The agent's Codex folder holds no usable sign-in, and Clawboo found none to copy from `~/.codex`. Run `codex login` in a terminal, then send the message or start the task again. The next run copies the new sign-in into the agent's folder.

</Accordion>

<Accordion title="Comments reach a Codex agent only at its next run">

The run fell back to `codex exec`, which cannot take input mid-run. That happens when the installed Codex has no `codex app-server`, or the app-server does not answer within 20 seconds. Update Codex with `npm install -g @openai/codex@0`, then try again.

</Accordion>

</AccordionGroup>

## Check that it works

1. In **Settings** > **Runtimes**, the **Codex** row reads **Connected**.
2. Open the team chat of a team with a Codex member. Type `@`, pick that agent, and ask: "Say hello in one sentence."
3. You should see a reply under the agent's name. If the run fails, the chat shows "The run failed:" and the reason; look it up in [Troubleshooting](#troubleshooting).

<Accordion title="Under the hood">

- Each run starts `codex app-server` with `CODEX_HOME` set to the agent's Codex folder, sends `initialize` (20-second limit), then `thread/start` or `thread/resume` with `approvalPolicy: 'never'` and `sandbox: 'danger-full-access'`, then one `turn/start`. Any request the app-server sends back is answered with an error.
- If the app-server cannot start or the handshake fails, the run uses `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`, or `codex exec resume <id>` to continue a thread.
- A comment on a running task goes in with `turn/steer`. A comment that arrives after the turn ended waits in the agent's mailbox for its next run.
- Run a board task on Codex directly with `POST /api/runtimes/codex/run`; see the [Runtimes API](/reference/rest-api/runtimes). A run without an agent id uses the folder `~/.clawboo/runtimes/codex/codex`, and its `costUsd` is the token estimate.

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Codex compares with the other runtimes.
- [Connect AI providers and runtimes](/using/providers-and-runtimes): the ChatGPT sign-in, keys and disconnecting.
- [What agents can do](/concepts/permissions): permissions and safety for every runtime.
- [Budgets and spend](/using/budgets-and-spend): how estimated costs reach your budgets.
- [Hermes](/runtimes/hermes) and [OpenClaw](/runtimes/openclaw): two more runtimes that can run on a ChatGPT plan, each with its own sign-in.
