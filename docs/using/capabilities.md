---
title: 'See what your agents can use'
sidebarTitle: 'Capabilities'
description: 'The Capabilities panel lists every skill, tool and connector across your runtimes, and switches the ones Clawboo is allowed to change.'
icon: 'puzzle'
keywords:
  [
    'Capabilities dashboard',
    'capability inventory',
    'skills',
    'tools',
    'Pending auth',
    'Unavailable',
  ]
---

The **Capabilities** panel is one list of everything your agents can use: skills, tools and connectors, grouped by the runtime that owns them. Use it to check what each runtime gives its agents, to find out why a row is greyed out, and to switch off the rows Clawboo is allowed to change.

## Open the panel

Open **Settings** (the gear in the sidebar, or **Cmd/Ctrl + ,**) and choose **Capabilities** under **Workspace**. The header counts what it found (`N capabilities · M runtimes`) and has a **Refresh** button. Approval cards waiting on you also appear at the top of the panel; see [Approvals](/using/approvals).

You can also start from a runtime: on the **Runtimes** page, open a runtime's diagnostics (the **i** button on its card) and press **View capabilities**. The panel opens showing only that runtime.

![The Capabilities panel in Settings, scrolled to the Claude Code group: its skills and tools with Ready pills, Disable on the two skills, and the built-in rows marked as managed by Claude Code](/images/capabilities-panel.png)

## Read the list

Rows are grouped by runtime, in this order: Clawboo Native, OpenClaw, Claude Code, Codex, Hermes. When more than one runtime has rows, pills above the list (**All runtimes**, then one per runtime) narrow it to one group. Each row's icon shows its kind: a puzzle piece for a skill, a wrench for a tool, a plug for a connector.

| Pill             | Meaning                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Ready**        | Available and on                                                                           |
| **Disabled**     | Available but switched off                                                                 |
| **Pending auth** | Listed but waiting on a sign-in. Only Codex rows show it, and they cannot be switched here |
| **Unavailable**  | Something it needs is missing, such as a key. The row is greyed out                        |

A row with no button reads **built-in, managed by** and the runtime's name: Clawboo can read it but not change it.

## What each runtime lists

| Group          | What it lists                                                                                                                                                                                  | Can you switch it here?                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Clawboo Native | Clawboo's own built-in tools; for each Clawboo Native agent, its **memory MCP**, **tasks MCP** and **tools MCP** servers; every connector you connected, and each app reached through Composio | The built-in tools and the per-agent servers, yes. Connectors, no: use [Connectors](/using/connectors) or the graph |
| OpenClaw       | The tools on the OpenClaw Gateway's allow and deny lists, the Gateway's MCP servers and plugins, the Clawboo servers registered there, and one **Built-in tools** row                          | Only the Gateway's tools, and only while the Gateway is connected                                                   |
| Claude Code    | The four Clawboo servers attached to every Claude Code run, and one **Built-in tools** row                                                                                                     | No                                                                                                                  |
| Codex          | The same four servers, marked **Pending auth**, and one **Built-in tools** row                                                                                                                 | No                                                                                                                  |
| Hermes         | The skills each Hermes agent wrote for itself, the servers Clawboo attaches to its runs, and one **Built-in tools** row                                                                        | No                                                                                                                  |

Skills you add to an agent are listed in the group of that agent's runtime. The panel does not say which agent a per-agent row belongs to; to see or change one agent's skills and connectors, open its ring on the [Org chart](/using/org-chart) or its page.

<Accordion title="About Clawboo's built-in tools">

The Clawboo Native group lists four built-in tools: `echo`, `note`, `web_search` and `delete_path`. They are simple tools that exercise Clawboo's approval checks. `web_search` reads **Unavailable** unless a Tavily key (`TAVILY_API_KEY`) is set, and neither it nor `delete_path` searches the web or deletes anything. For real web access, give an agent a browser or a search connector; see [Connectors](/using/connectors).

</Accordion>

## Switch a capability on or off

<Steps>

<Step title="Find the row">

Use a runtime pill, or scroll to the group.

</Step>

<Step title="Press Disable or Enable">

The row shows a spinner while Clawboo makes the change.

</Step>

<Step title="Check the pill">

The panel reloads, and the pill flips between **Ready** and **Disabled**. If Clawboo cannot make the change, a message starting **Could not disable** (or **Could not enable**) says why, and nothing changes.

</Step>

</Steps>

What the switch does depends on the row:

| Row                                                       | **Disable** does                                         | **Enable** does                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A built-in tool                                           | Turns the tool off for every agent                       | Turns it back on                                                                                                                                        |
| An agent's **memory MCP**, **tasks MCP** or **tools MCP** | Takes that server's tools away from that one agent       | Gives them back. For an agent on a team, **tasks MCP** comes back with read access to the board only, because the team's engine makes the board changes |
| An OpenClaw Gateway tool                                  | Puts the tool on the Gateway's deny list                 | Puts it on the allow list                                                                                                                               |
| A skill                                                   | Removes the skill from that agent, so the row disappears | Not offered: add the skill again from the [Marketplace](/using/marketplace) or the graph                                                                |

## Skills

A skill in Clawboo is a label for something an agent is good at, chosen from the Marketplace's built-in list. You add one from the **Skills** tab of the [Marketplace](/using/marketplace), or on the graph: pull a thread off a Boo, or press **+**, and pick from **Skills**.

Adding a skill records it on the agent: it appears in this panel and as a tile on the agent's ring. It does not give the agent a new tool or change its instructions. Tools come from [connectors](/using/connectors) and from the runtime itself.

Hermes is the exception in this list: the skills under the Hermes group are skill files a Hermes agent wrote for itself, which Hermes reads. Clawboo shows them and never changes them.

<Accordion title="Under the hood">

Every row has a manageability tier that decides whether Clawboo may change it:

| Tier                        | Who owns it                                                             | Switch in the panel                                                     |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Managed                     | Clawboo (its built-in tools, the per-agent servers, skills)             | Yes                                                                     |
| Written through the runtime | The runtime's own files, which Clawboo would edit on its behalf (Codex) | No: Clawboo makes no Codex changes, so these rows stay **Pending auth** |
| Runtime of record           | The runtime, which Clawboo asks to make the change (OpenClaw)           | Only where Clawboo can make that request: the Gateway's tools           |
| Observe only                | The runtime or a running connector                                      | Never                                                                   |

The panel reads `GET /api/capabilities` and switches rows with `POST /api/capabilities/enable` or `/disable`, which refuse a row its tier forbids with `422`. When a runtime cannot be read, the server serves the rows it last read for it. The model behind the tiers is in [Capabilities](/concepts/capabilities), and the request shapes are in the [capabilities API reference](/reference/rest-api/capabilities).

</Accordion>

## Troubleshooting

<AccordionGroup>

<Accordion title="A row is greyed out and reads Unavailable">

Something the capability needs is missing, such as an API key or a setting. Provide it, then press **Refresh**. The row offers no button until it is available.

</Accordion>

<Accordion title="Codex rows read Pending auth and Enable is greyed out">

Clawboo lists Codex's servers so you can see them, but it makes no changes to Codex. The button's hint suggests running `codex login`; signing in does not change these rows.

</Accordion>

<Accordion title="An OpenClaw server or plugin has no button">

Clawboo can switch only the Gateway's tools. Turn the Gateway's MCP servers and plugins on or off in OpenClaw itself; see the [OpenClaw runtime page](/runtimes/openclaw).

</Accordion>

<Accordion title="Switching a Gateway tool fails with gateway_disconnected">

Gateway tools are changed through the OpenClaw Gateway, so it must be connected. The panel keeps showing the rows it last read while the Gateway is down. Reconnect it, then try again.

</Accordion>

<Accordion title="A warning says a runtime is unavailable and shows its last-known capabilities">

Clawboo could not read that runtime just now, for example because the OpenClaw Gateway is disconnected, so it shows the rows it read last time. Fix the connection, then press **Refresh**.

</Accordion>

<Accordion title="The panel says it could not load the capability inventory">

The panel could not reach the Clawboo server. Press **Retry**. This is different from **No capabilities found**, which means the server answered with an empty list.

</Accordion>

</AccordionGroup>

## Next steps

- [Connectors](/using/connectors): connect tools and give them to agents.
- [Marketplace](/using/marketplace): add skills, agents and teams.
- [Approvals](/using/approvals): answer the cards at the top of this panel.
- [Capabilities](/concepts/capabilities): the model behind the inventory and its tiers.
- [Capabilities API](/reference/rest-api/capabilities): read and switch rows from scripts.
