---
title: 'Using Clawboo: the feature map'
description: A navigation index to every Clawboo dashboard feature, grouped by where it lives in the UI.
---

Clawboo's dashboard is a single window: a sidebar on the left (the team rail and an agent column you can resize or collapse) and the main content area. The main area is a [discriminated `ViewMode`](/appendices/glossary): clicking a team icon opens the team's **Home**, its rooms open a **team chat**, clicking an agent opens its **agent page**, and the sidebar's nav buttons and the Settings modal switch the main area to one of fifteen full-screen **nav panels** (`NAV_VIEWS` in `stores/view.ts`, each mapped to a lazily-loaded feature component by `NavPanel` in `features/layout/navPanels.tsx`, which also wraps each panel in its own error boundary). A few surfaces, Teams, Group chat, Agents, Boo Zero, Home, and Theming, are reached through the team rail, the agent column's mascot grid and rooms list, the Home row, or the theme toggle rather than a nav button. This page is mostly navigation; each linked how-to grounds itself in its own feature module and backing API route(s).

## Team-scoped surfaces

These live in the sidebar and follow the currently selected team. The team rail (`TeamSidebar`) and the agent column (`AgentListColumn`) drive them.

- **[Teams](/using/teams)**: Create and manage teams, set the team leader, capture per-team rules, and pick a color collection. Reached from the team rail's **+** (Create a team) button and right-click context menu.
- **[Group chat](/using/group-chat)**: The team's collaboration room, opened from **General** in the agent column's rooms list. A team can add more **rooms**, each a subset of its members with its own conversation, and any chat can be cleared from its row's **"..."** menu. Gated once per team by the "Know Your Team" onboarding flow before the composer unlocks.
- **[Ghost Graph & Org chart](/using/ghost-graph)**: The team's agent topology (the **Team graph** card beside a team's chat) and the all-teams **Org chart** (formerly Atlas; the `graph` nav slot). Halos, team badges, peacock expand/collapse, the Boo port and the + button for building on the canvas, and the Org chart's activity and browser docks live here.
- **[Agents](/using/agents)**: Click any tile in the mascot grid to open that agent's page: its chat, with cards beside it for its graph, tasks and routines, browser, activity, and details (the personality sliders and the agent-file editors).
- **[Boo Zero](/using/boo-zero)**: The universal team leader. Its standalone view (opened from the mascot icon) hosts the display name and global brief; per-team briefs and rules live behind the gear in a team chat's header.
- **[Home](/getting-started/dashboard-tour#home)**: Each team's Home, opened from its icon in the team rail or the **Home** row at the top of the nav. For now it is a placeholder for the team's dashboards and the artifacts its agents make.

## Org-wide nav panels

These open from the nav buttons at the bottom of `AgentListColumn` or from the Settings modal (`Cmd/Ctrl+,`); [Where things live](#where-things-live-nav-slots) says which. Each switches the main content area to a full-screen panel; all are always available (no feature gates).

- **[Board](/using/board)**: The durable kanban board, fused with chat, laid out as a calendar: status columns across the top, days down the side, upcoming routine runs on their days, and a **Needs you** column for approvals and stuck tasks. Cards show the agent, the runtime, and a verification mark or the cost.
- **[Marketplace](/using/marketplace)**: Browse and deploy the 436 first-class agents and 85 workflow teams across a Skills / Agents / Teams tab strip.
- **[Connectors](/using/connectors)**: Connect MCP servers and apps for your agents to use, and see the grants that govern their tools.
- **[Cost & budgets](/using/cost-and-budgets)**: The **Tokens Used** dashboard: per-agent and per-team token usage and trends, plus USD budgets via the Governance surface.
- **[Routines](/using/routines)**: Recurring work for a team or one agent, plus the OpenClaw Gateway's own cron jobs.
- **[Memory](/using/memory-browser)**: Search, save, and browse the shared Memory-MCP tier (facts and procedures).
- **[Capabilities](/using/capabilities-dashboard)**: The unified capability inventory across all runtimes, grouped by runtime and kind, with manageability-derived actions.
- **[Observability](/using/observability-dashboard)**: Traces, the error taxonomy, fleet health, the delegation-graph projection, and the eval scorecard.
- **[Governance](/using/governance-dashboard)**: Budgets, caps, the audit log, and the shared tool-approval queue.
- **[System](/using/system-maintenance)**: Gateway control, default model, API keys, agent coordination, and system info.
- **[System health](/using/system-health)**: The boot-probe checklist and resolved runtime state, the one liveness surface that answers with the Gateway down.

## App-wide

- **[Approvals](/using/approvals)**: The pending-approval queue (Gateway exec approvals, native `run_command` requests, and the brokered tool-approval queue). Not a nav panel: it renders in the Board's **Needs you** column and as an inline tray above the group-chat composer.
- **[Theming](/using/theming)**: The light/dark/system theme toggle in the bottom-left of the sidebar (`ThemeToggle`); fresh installs default to light.

## Where things live (nav slots)

The fifteen nav panels map one-to-one to `NavView` ids. The table is the same wiring `ContentArea` uses, so it doubles as a reference for the `navigateTo(view)` action. Five panels live in the sidebar nav, in this order: Org chart, Board, Connectors, Memory, Marketplace. The first four have a number shortcut, `Cmd/Ctrl+1` to `Cmd/Ctrl+4`, in that order. The Settings modal (`Cmd/Ctrl+,`) holds the other ten, Fleet among them, plus Memory, which is in both places on purpose: the sidebar opens it full-screen with its graph, and Settings shows the list. A team's **Home** row sits above the nav when a team is selected, but Home is a view of its own, not a nav panel. `Cmd/Ctrl+\` collapses or expands the sidebar.

| Nav id (`NavView`) | Label         | Lives in                                        | Page                                                      |
| ------------------ | ------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `graph`            | Org chart     | Sidebar, `Cmd/Ctrl+1`                           | [Ghost Graph & Org chart](/using/ghost-graph)             |
| `board`            | Board         | Sidebar, `Cmd/Ctrl+2`                           | [Board](/using/board)                                     |
| `connectors`       | Connectors    | Sidebar, `Cmd/Ctrl+3`                           | [Connectors](/using/connectors)                           |
| `memory`           | Memory        | Sidebar (`Cmd/Ctrl+4`) and Settings (Workspace) | [Memory browser](/using/memory-browser)                   |
| `marketplace`      | Marketplace   | Sidebar                                         | [Marketplace](/using/marketplace)                         |
| `providers`        | Providers     | Settings (Workspace)                            | [Connecting runtimes](/runtimes/connecting-runtimes)      |
| `runtimes`         | Runtimes      | Settings (Workspace)                            | [Connecting runtimes](/runtimes/connecting-runtimes)      |
| `capabilities`     | Capabilities  | Settings (Workspace)                            | [Capabilities dashboard](/using/capabilities-dashboard)   |
| `routines`         | Routines      | Settings (Workspace)                            | [Routines](/using/routines)                               |
| `fleet`            | Fleet         | Settings (Insights)                             | [Dashboard tour](/getting-started/dashboard-tour)         |
| `cost`             | Tokens Used   | Settings (Insights)                             | [Cost & budgets](/using/cost-and-budgets)                 |
| `obs`              | Observability | Settings (Insights)                             | [Observability dashboard](/using/observability-dashboard) |
| `governance`       | Governance    | Settings (Insights)                             | [Governance dashboard](/using/governance-dashboard)       |
| `system`           | System        | Settings (System)                               | [System & maintenance](/using/system-maintenance)         |
| `health`           | System Health | Settings (System)                               | [System health](/using/system-health)                     |

<Note>
The `fleet` panel (a read-only overview, in the Settings modal under Insights) does not have its own how-to; it is covered in the [dashboard tour](/getting-started/dashboard-tour).

**Approvals is not a nav slot.** It has a how-to page ([Approvals](/using/approvals)) but no `NavView` id: approvals render in the [board](/using/board)'s **Needs you** column and in an inline tray above the [group-chat](/using/group-chat) composer.
</Note>

![The team space: Ghost Graph above the group chat for a selected team](/images/team-space.png)

## See also

- [Dashboard tour](/getting-started/dashboard-tour): the sidebar, the Org chart, and the view modes, end to end
- [First team](/getting-started/first-team): deploy a team and watch it collaborate
- [Concepts](/concepts/index): the models behind these features (the board, peer chat, verification, governance)
- [Runtimes overview](/runtimes/index): the five runtime classes and the capability matrix
- [REST API reference](/reference/rest-api/index): every backing route
