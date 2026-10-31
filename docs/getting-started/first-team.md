---
title: 'Work with your first team'
sidebarTitle: 'First team'
description: 'Give your team a job, watch Boo Zero split it into tasks, find the results, and steer, approve or stop the work.'
keywords:
  [
    'first team',
    'delegation',
    'hand-off',
    'Know Your Team',
    'team chat',
    'group chat',
    'steer',
    'stop',
  ]
---

Use this page once you have a deployed team, for example from the [Quickstart](/getting-started/quickstart). You'll open the team chat, give the team a job, watch it work, find the results, and steer or stop the work.

## Before you begin

- **A deployed team.** Deploy one in the [Quickstart](/getting-started/quickstart), or click **+** (**Create a team**) at the bottom of the left rail to pick one from the Marketplace.
- **A connected AI provider or runtime**, so the agents can answer.

## Steps

<Steps>

<Step title="Open the team chat">

Click the team's icon on the left rail to open its Home, then click **General** below the team's agents. General is the chat with the whole team.

The first time you open a team's chat, a one-time introduction comes first:

1. **Meet your team** shows the agents and the leader. Click **Get Started**.
2. **Introduce yourself:** write who you are and what you're working on (at least 5 characters), then click **Continue to Team Space**. Clawboo saves it to the team's context.

A team you deployed during setup skips the first screen. [Team chat](/using/team-chat) covers this screen, rooms and clearing a chat.

**You should see** the chat on the left, with the **Team graph** and **Tasks** cards on the right.

</Step>

<Step title="Give the team a job">

Type your request in the message box and press Enter (Shift+Enter starts a new line). Your message goes to Boo Zero, which decides who should do what. To talk to one agent instead, start the message with `@` and its name; the message is delivered exactly as you typed it.

Ask for work with clear parts and a clear result. For example:

```text
Write a welcome email series for new customers of our budgeting app: three short emails with subject lines, and a note on when to send each one.
```

```text
Turn these meeting notes into a short summary, a list of decisions, and a task list with an owner for each task: (paste your notes here)
```

A quick question gets a direct answer. Work with several parts is split into tasks.

**You should see** task cards appear in the chat as Boo Zero hands out the parts.

</Step>

<Step title="Watch the team work">

Each hand-off becomes a task on the board, assigned to one teammate. You can follow it in three places:

- **Task cards in the chat.** Each card names its teammate and shows a status that moves from **Queued** to **Working** to **Done**. A task that needs you shows why instead, such as **Failed** or **Stopped**.
- **The Tasks card** beside the chat sorts this chat's tasks into **Needs you**, **In progress**, **To do**, **Done** and **Cancelled**.
- **The Team graph card** shows the team, with a live status on each agent.

The [Board](/using/board) holds every task from every team, by status and by day. Team chat runs on the Clawboo server, so the work continues if you close the browser tab.

</Step>

<Step title="Find the results">

- **Boo Zero's answer.** When the teammates finish, Boo Zero posts one summary in the chat.
- **Each teammate's answer** is saved on its task. Open **Comments & activity** on the task card in the chat, or open the task on the Board, and read the teammate's comment.
- **Files.** Agents return their results as text. Claude Code, Codex, Hermes and OpenClaw agents can also write files. In team chat, Claude Code, Codex and Hermes start in Clawboo's own data folder (`~/.clawboo`), so name the full folder path you want when you ask for files. OpenClaw agents work in their own OpenClaw workspace. [What agents can do](/concepts/permissions) explains what each runtime may touch.

![Boo Zero's summary in a team chat: it reports what three teammates produced for a pricing page and what is still open, with the Team graph and Tasks cards on the right](/images/leader-synthesis.png)

</Step>

<Step title="Steer, approve or stop">

- **Steer a running task.** Open the task in the **Tasks** card, write in **Comment or steer this task…** and send. The agent working on it reads your comment while it works, and a task that has not started yet gets it when it does. [Choose a runtime](/runtimes/index) shows how each runtime takes a comment.
- **Approve.** Some actions wait for your OK. They appear in **Needs you** on the Board and in a tray above the message box; see [Approvals](/using/approvals). Claude Code, Codex and Hermes use their own built-in tools without asking.
- **Stop.** While the team works, the send button turns into **Stop**. Stop ends the team's runs in this chat and drops hand-offs that have not started. Tasks that were running wait in **Needs you** as **Stopped** and don't restart on their own; retry them from there when you're ready.

</Step>

</Steps>

## How Boo Zero hands out work

Boo Zero answers what it can and hands out the rest. Each hand-off becomes a task on the board, assigned to a teammate. When the teammate finishes, its result is saved as a comment on the task and passed back to the agent that handed it out. Boo Zero then writes your answer.

<Accordion title="Under the hood">

The leader hands off a job with a structured signal, never by Clawboo guessing from its prose. The signal depends on the runtime the leader runs on:

| Leader runs on               | How it hands off a job                                      |
| ---------------------------- | ----------------------------------------------------------- |
| Clawboo Native               | Calls its `delegate` tool                                   |
| Claude Code, Codex or Hermes | Calls the `team_delegate` tool on Clawboo's TeamChat server |
| OpenClaw                     | Writes a `<delegate to="@Name">` block in its reply         |

Clawboo limits how deep hand-offs can nest and how many one turn can send out, and stops sending a task to a teammate that keeps failing it. [Limits and defaults](/reference/limits-and-defaults) has the numbers, and [How a team works](/intro/how-it-works) follows the whole path.

</Accordion>

## Good to know

- **Team chat work is not checked automatically.** Review the results, or add a reviewer agent to the team and ask Boo Zero to have it check the work. See [How work is checked](/concepts/verification).
- **A team costs more tokens than one agent.** Boo Zero, each teammate and the final summary are separate model runs. See [Budgets and spend](/using/budgets-and-spend).

## Next steps

- [Team chat](/using/team-chat): rooms, mentions and clearing a chat.
- [Teams](/using/teams): change a team's members, leader, brief and rules.
- [Board](/using/board): every task, steering comments and **Needs you**.
- [Routines](/using/routines): give the team work on a schedule.
- [Tour the dashboard](/getting-started/dashboard-tour): find your way around the rest of the app.
