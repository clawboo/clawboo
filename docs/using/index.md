---
title: 'Use Clawboo'
sidebarTitle: 'Overview'
description: 'Find the how-to for what you want to do, and where each part of the dashboard lives: the sidebar, team chats, the board and Settings.'
icon: 'layout-dashboard'
keywords: ['feature map', 'navigation', 'sidebar', 'settings', 'where is', 'dashboard', 'nav']
---

Use this page to find the how-to for what you want to do, and to learn where things are in the dashboard. Each how-to is a short set of steps that uses the labels you see on screen.

## Find what you want to do

### Build your team

| I want to...                                                         | Go to                                 |
| -------------------------------------------------------------------- | ------------------------------------- |
| Start a team from a ready-made template, or from scratch             | [Teams](/using/teams)                 |
| Look through ready-made teams, agents and skills before I deploy one | [Marketplace](/using/marketplace)     |
| Add one agent, or change an agent's model, personality or files      | [Agents](/using/agents)               |
| Set rules that every member of a team follows                        | [Team rules](/using/teams#team-rules) |
| Understand how Boo Zero, my team leader, coordinates every team      | [Boo Zero](/using/boo-zero)           |

### Work with your team

| I want to...                                                  | Go to                         |
| ------------------------------------------------------------- | ----------------------------- |
| Ask a team for something and follow the conversation          | [Team chat](/using/team-chat) |
| Work with part of a team in its own room                      | [Team chat](/using/team-chat) |
| See every task, what needs me, and what got done              | [Board](/using/board)         |
| Comment on a running task to steer it                         | [Board](/using/board)         |
| See how my agents are organized, and attach tools by dragging | [Org chart](/using/org-chart) |

### Connect AI and tools

| I want to...                                                         | Go to                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| Add an API key, sign in with ChatGPT, or use a local model on Ollama | [Providers and runtimes](/using/providers-and-runtimes) |
| Add a runtime such as Claude Code, Codex, Hermes or OpenClaw         | [Providers and runtimes](/using/providers-and-runtimes) |
| Pick the right runtime for a job                                     | [Choose a runtime](/runtimes/index)                     |
| Give agents apps and tools, such as GitHub or a web browser          | [Connectors](/using/connectors)                         |
| See every tool and skill each agent can use                          | [Capabilities](/using/capabilities)                     |
| See or add what my team remembers                                    | [Memory](/using/memory)                                 |

### Automate

| I want to...                                       | Go to                       |
| -------------------------------------------------- | --------------------------- |
| Have a team or an agent do something on a schedule | [Routines](/using/routines) |

### Stay in control

| I want to...                                             | Go to                                             |
| -------------------------------------------------------- | ------------------------------------------------- |
| Answer an agent that asks to run a command or use a tool | [Approvals](/using/approvals)                     |
| Decide which commands an agent may run without asking    | [Command permissions](/using/command-permissions) |
| See what I am spending, and set a budget                 | [Budgets and spend](/using/budgets-and-spend)     |
| Understand what agents can do on my computer             | [What agents can do](/concepts/permissions)       |

### Monitor and maintain

| I want to...                                          | Go to                                    |
| ----------------------------------------------------- | ---------------------------------------- |
| See how my agents and runs are doing, and find errors | [Observability](/using/observability)    |
| Find out why part of Clawboo is not working           | [System Health](/using/system-health)    |
| Update OpenClaw, or set its default command approval  | [System](/using/system)                  |
| Switch between light and dark mode                    | [Theming](/using/theming)                |
| Fix something that went wrong                         | [Troubleshooting](/help/troubleshooting) |

### Go further

| I want to...                                                                  | Go to                            |
| ----------------------------------------------------------------------------- | -------------------------------- |
| Follow a worked example, such as a content team or running without an API key | [Recipes](/guides/index)         |
| Run Clawboo for my team, or on another machine                                | [Self-hosting](/operating/index) |

## Where things live

The dashboard has a sidebar on the left and a main area beside it. Everything opens from the sidebar.

![A team's General chat: the sidebar on the left, the chat in the middle, and the Team graph and Tasks cards on the right](/images/team-space.png)

### The sidebar

The sidebar has two columns.

The **team rail** is the narrow column on the far left:

- Boo Zero's red mascot sits at the top. Click it to open [Boo Zero](/using/boo-zero)'s page. Right-click it and choose **Show all agents** to list every agent.
- Each team has an icon. Click one to open that team. Right-click it to archive the team, refresh its protocol, or delete it (see [Teams](/using/teams)).
- The dashed **+** at the bottom (**Create a team**) opens the [Marketplace](/using/marketplace) on its **Teams** tab.

The **agent column** sits next to it. From top to bottom:

- The team's name, with a search icon that filters its agents.
- The team's agents, one Boo tile each, with Boo Zero last. Click a tile to open that [agent's page](/using/agents).
- **New room**, then **General (Main Room)** and your rooms: the team's chats.
- **Create Boo**, which adds an agent to this team.
- The nav rows (below), then the theme switch.

**Home** and the team's chats appear once the team has at least one agent. Press `Cmd/Ctrl+\` to hide or show the sidebar, and drag its edge to resize it.

### The nav

| Row             | What it opens                                                 | Shortcut     |
| --------------- | ------------------------------------------------------------- | ------------ |
| **Home**        | The team's home page, which holds only a placeholder          |              |
| **Org chart**   | Every team and agent in one chart, led by Boo Zero            | `Cmd/Ctrl+1` |
| **Board**       | Every task, by status and by day, with a **Needs you** column | `Cmd/Ctrl+2` |
| **Connectors**  | Apps and tools you connect for your agents                    | `Cmd/Ctrl+3` |
| **Memory**      | What your agents have saved, as a graph or a list             | `Cmd/Ctrl+4` |
| **Marketplace** | Ready-made teams, agents and skills                           |              |
| **Settings**    | Setup, insights and system panels, in three groups (below)    | `Cmd/Ctrl+,` |

### A team's chats

Click **General** or a room in the agent column. The chat fills the main area. Its header has a gear for the team's brief and rules. It also has buttons that show or hide four cards beside the chat: **Browser**, **Team graph** (**Room graph** in a room), **Tasks** and **Activity**. See [Team chat](/using/team-chat).

### Settings

Open **Settings** from the sidebar, or press `Cmd/Ctrl+,`. It opens on **Runtimes**. Type in **Search settings** to find a panel by what it does, for example "api key" or "cron".

| Group         | Panel             | What it is for                                                          | How-to                                                  |
| ------------- | ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| **Workspace** | **Providers**     | API keys and the ChatGPT sign-in                                        | [Providers and runtimes](/using/providers-and-runtimes) |
|               | **Runtimes**      | Connect, install and manage the five runtimes                           | [Providers and runtimes](/using/providers-and-runtimes) |
|               | **Memory**        | The memory list (the sidebar's **Memory** adds the graph)               | [Memory](/using/memory)                                 |
|               | **Capabilities**  | Every tool, skill and connector, grouped by runtime                     | [Capabilities](/using/capabilities)                     |
|               | **Routines**      | Scheduled work for teams and agents                                     | [Routines](/using/routines)                             |
| **Insights**  | **Fleet**         | An overview of your agents, recent runs and spend                       | [Observability](/using/observability)                   |
|               | **Tokens Used**   | Token use by team and agent                                             | [Budgets and spend](/using/budgets-and-spend)           |
|               | **Observability** | Traces, errors and fleet health                                         | [Observability](/using/observability)                   |
|               | **Governance**    | Budgets, the audit log and the approval queue                           | [Budgets and spend](/using/budgets-and-spend)           |
| **System**    | **System**        | OpenClaw's default command approval, versions and **Check for Updates** | [System](/using/system)                                 |
|               | **System Health** | Start-up checks for Clawboo's own parts                                 | [System Health](/using/system-health)                   |

### Approvals

Approvals have no panel of their own. They appear where you are working: in the board's **Needs you** column, above the message box in a chat, and in the **Tasks** cards. The **Governance** and **Capabilities** panels list them too. See [Approvals](/using/approvals).

## Next steps

- [Deploy your first team](/getting-started/first-team): go from a template to a finished task.
- [Dashboard tour](/getting-started/dashboard-tour): a guided look at each part of the screen.
- [Key concepts](/concepts/index): how teams, the board and runtimes fit together.
- [Keyboard shortcuts](/reference/keyboard-shortcuts): every shortcut in one place.
- [Glossary](/appendices/glossary): the names you see in the app, and what they mean.
