---
title: 'Tour the dashboard'
sidebarTitle: 'Dashboard tour'
description: 'A map of the Clawboo dashboard: the team rail, the agent column, the sidebar nav, Settings, team chats, the Org chart and agent pages.'
icon: 'map'
keywords:
  ['sidebar', 'navigation', 'layout', 'settings', 'Atlas', 'Ghost Graph', 'Fleet', 'team space']
---

Use this page to find your way around. The dashboard is one browser window: a sidebar on the left, and the page you are working on to its right. When you open Clawboo, it starts on the Org chart.

![The Clawboo dashboard: on the left the team rail and the agent column with the team's agents, its General chat and the nav; in the middle a team chat; on the right the Team graph and Tasks cards](/images/team-space.png)

## The sidebar

The sidebar has two parts: a narrow team rail on the far left, and the agent column next to it.

### Team rail

- **Boo Zero** (the red mascot at the top) opens Boo Zero's own page, where you talk to the leader of all your teams. Right-click it and choose **Show all agents** to open the Org chart.
- **One icon per team.** Click an icon to open that team's **Home**. Right-click it for **Archive**, **Refresh Protocol**, **Delete team only** and **Delete with agents**; [Teams](/using/teams) explains each. Archiving takes a team off the rail, which puts its chats and Home out of reach. Nothing is deleted, but the dashboard has no list of archived teams to bring one back from.
- **+** (**Create a team**) opens the Marketplace's **Teams** tab, where you deploy a ready-made team or start one from scratch.

### Agent column

From top to bottom:

- **The team's name** (or **All Agents** when no team is selected), a search for agents, and the button that hides the sidebar.
- **The team's agents**, each drawn as a Boo. A pulsing green dot marks an agent that is working and a red dot one with an error. Boo Zero comes last. Click an agent to open its page.
- **The team's chats:** **New room**, then **General**, the chat with the whole team, then any rooms you made. A room is a smaller group of teammates with its own chat; see [Team chat](/using/team-chat).
- **Create Boo** adds an agent to the team. It runs on OpenClaw while an OpenClaw Gateway is connected, and on Clawboo Native otherwise.
- **The nav**, described below, and the theme switch (**System**, **Light**, **Dark**).

Drag the agent column's edge to resize it; double-click the edge to reset it. To hide the whole sidebar, drag the edge far to the left, click the hide button, or press `Cmd/Ctrl + \`. While it is hidden, a button at the start of each page's header brings it back, and hovering that button shows the sidebar without docking it.

### The nav

| Item                               | What it opens                                                                                                                     | Shortcut       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Home** (when a team is selected) | The team's Home page, a placeholder. To work with the team, open **General**                                                      | None           |
| **Org chart**                      | Every team on one live chart, under Boo Zero                                                                                      | `Cmd/Ctrl + 1` |
| **Board**                          | Every task by status on **Kanban**, or by day in **Today**, **Week** and **Month**, with anything waiting on you in **Needs you** | `Cmd/Ctrl + 2` |
| **Connectors**                     | Apps and tools your agents can use, such as GitHub, Gmail or a local folder                                                       | `Cmd/Ctrl + 3` |
| **Memory**                         | The team memory, as a graph and a list                                                                                            | `Cmd/Ctrl + 4` |
| **Marketplace**                    | Ready-made agents, teams and skills                                                                                               | None           |
| **Settings**                       | Everything else, in one window (below)                                                                                            | `Cmd/Ctrl + ,` |

There is no separate approvals page. Requests that wait for your OK appear in **Needs you** on the Board and in a tray above the chat's message box; see [Approvals](/using/approvals).

## Settings

**Settings** opens a window with eleven items in three groups. **Search settings** at the top finds an item by name, or by words such as "api key" or "cron".

| Group     | Item              | What it's for                                                                                                                                                     |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace | **Providers**     | Add, check and remove AI provider keys, and sign in with your ChatGPT subscription                                                                                |
| Workspace | **Runtimes**      | Connect and manage Clawboo Native, OpenClaw, Claude Code, Codex and Hermes                                                                                        |
| Workspace | **Memory**        | The team memory as a list (the sidebar's **Memory** adds the graph)                                                                                               |
| Workspace | **Capabilities**  | The tools, skills and connectors your agents can use                                                                                                              |
| Workspace | **Routines**      | Work that runs on a schedule, for a team or for one agent                                                                                                         |
| Insights  | **Fleet**         | All agents at a glance: 24-hour task and verify pass rates, spend, health per runtime, recent issues                                                              |
| Insights  | **Tokens Used**   | Token counts by team and agent, for OpenClaw agents only                                                                                                          |
| Insights  | **Observability** | Traces, errors and health views from Clawboo's event log                                                                                                          |
| Insights  | **Governance**    | Budgets, limits and the audit log                                                                                                                                 |
| System    | **System**        | OpenClaw's default command approval (while a Gateway is connected), OpenClaw and Node.js versions, and **Check for Updates**, which updates OpenClaw, not Clawboo |
| System    | **System Health** | Startup checks, with a way to run them again                                                                                                                      |

[Providers and runtimes](/using/providers-and-runtimes) walks through the first two. To update Clawboo itself, see [Install](/getting-started/installation).

## Team chats

Click **General** or a room to open a team chat: the conversation on the left, cards on the right. The header shows the chat's members (in a room, click them to **Edit room members**), a gear for the team's **brief & rules**, and one button per card:

- **Browser**: the page each of the chat's agents has open in its web browser. Every new agent gets the built-in browser connectors.
- **Team graph** (**Room graph** in a room): the team, with a live status on each agent.
- **Tasks**: the chat's tasks in **Needs you**, **In progress**, **To do**, **Done** and **Cancelled**. Open a task to read its comments, steer it, or open it on the Board.
- **Activity**: a live feed of the agents' tool calls, results and errors.

The graph and **Tasks** start open. Your browser remembers which cards you keep open and how you sized them. The first time you open a team's chat, a one-time introduction screen comes first; see [Work with your first team](/getting-started/first-team).

## The Org chart and a team's graph

The **Org chart** shows every team at once, with Boo Zero at the top. It opens in a radial layout; switch to **Tree** at the top right. A single team's graph is the **Team graph** card beside its chat. [Org chart](/using/org-chart) covers both, including how to build a team on the canvas.

![The Org chart in its Tree layout with team halos on: Boo Zero at the top, and each team's agents in a labeled row beneath it](/images/ghost-graph.png)

## The agent page

Click an agent to open its page: its chat on the left, and cards on the right that you turn on and off from the chat's header.

- **Graph**: the agent with its skills, connectors and model. Change the model from the card's top corner.
- **Tasks & Routines**: the agent's tasks, which you can open and steer, and the routines that send it work, with **New routine**.
- **Browser** and **Activity**: as in a team chat.
- **Details**: **Workspace**, **Personality**, **Permissions** (on OpenClaw and Clawboo Native agents), **Brief** (on Boo Zero only) and **Agent Files**, its SOUL.md and other files. Which files an agent follows depends on its runtime.

**Graph** and **Details** start open. [Agents](/using/agents) covers each card. In Boo Zero's own chat, start your message with `@` and a team's name, or click the team's chip above the message box, to bring that team's brief into your message; see [Boo Zero](/using/boo-zero).

![An agent page: the chat on the left, the Graph card at the top right with the agent's skills, connectors and model, and the Details card below it with its section pills and the personality presets and sliders](/images/agent-detail.png)

## Keyboard shortcuts

| Keys                  | What they do                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Cmd/Ctrl + 1` to `4` | Open the Org chart, Board, Connectors or Memory                                                                      |
| `Cmd/Ctrl + ,`        | Open Settings                                                                                                        |
| `Cmd/Ctrl + \`        | Hide or show the sidebar                                                                                             |
| `Escape`              | Close Settings; otherwise go from an agent page, Boo Zero's page, a team's Home or a team chat to the welcome screen |

Shortcuts other than `Cmd/Ctrl + \` don't fire while you type in a text field. The welcome screen has buttons for the Org chart, the Marketplace and **Cost**, which opens **Tokens Used**. [Keyboard shortcuts](/reference/keyboard-shortcuts) also lists the Board and graph keys.

## Next steps

- [Work with your first team](/getting-started/first-team): give a team a job and find the results.
- [Team chat](/using/team-chat): rooms, mentions and clearing a chat.
- [Board](/using/board): tasks, **Needs you** and steering.
- [Org chart](/using/org-chart): the all-teams chart and each team's graph.
- [Agents](/using/agents): the agent page, models, personality and files.
- [Keyboard shortcuts](/reference/keyboard-shortcuts): every shortcut in one place.
