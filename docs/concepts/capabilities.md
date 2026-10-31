---
title: 'Capabilities'
sidebarTitle: 'Capabilities'
description: 'What the capability inventory shows, the six places its skills, tools and connectors come from, and which of them Clawboo can change.'
keywords:
  [
    'capabilities',
    'capability inventory',
    'capabilities dashboard',
    'skills',
    'tools',
    'connectors',
    'grants',
    'manageability',
    'observe-only',
    'runtime-of-record',
  ]
---

A **capability** is a skill, a tool or a connector that an agent can use. Each runtime keeps track of its own in a different way, so Clawboo gathers them into one **capability inventory**. You see it in the **Capabilities** panel (**Settings**, then **Workspace**, then **Capabilities**) and as the tiles around each Boo on the Org chart.

For every entry, the inventory also records who owns it, which decides whether Clawboo can change it or can only show it. Use this page to understand what the inventory shows, where entries come from, and what you can change.

## The mental model

Think of the inventory as one stock list for several stockrooms. Clawboo owns some of the stockrooms, so it can switch items on and off there. The others belong to a runtime: Clawboo can read the labels, and in one case ask the runtime to make a change, but it never rearranges a runtime's own shelves.

## What the inventory shows

- **Three kinds of entry**: skills, tools and connectors.
- **Where each one belongs**: the runtime that owns it, and whether it belongs to one agent or to every agent on that runtime.
- **A status**: **Ready**, **Disabled**, **Pending auth** or **Unavailable**. An unavailable entry is greyed out, with the reason.
- **The action Clawboo can take**, if any: **Enable** or **Disable**. An entry Clawboo can only show reads "built-in, managed by" and the runtime's name.

The panel groups entries by runtime, with a filter for each one, a **Refresh** button, and any pending tool approvals at the top. Sometimes a runtime cannot be read, for example while your OpenClaw Gateway is offline. The panel then says so and shows the last entries it knew for that runtime.

## Where entries come from

The inventory reads from six sources. What Clawboo may do with an entry depends on its source.

| Source      | What it reads                                                                                                                                                                                       | Can Clawboo change it?                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clawboo     | The tools Clawboo's tool broker serves (such as `web_search`), each Clawboo Native agent's switches for the Memory, Tasks and Tools servers, and skills installed from the Marketplace on any agent | Yes. Clawboo owns these, so **Enable** and **Disable** work. Skills are installed from the [Marketplace](/using/marketplace).                                                                   |
| Hermes      | The `SKILL.md` skills and the `mcp.json` connectors in each Hermes agent's home, and Hermes's built-ins                                                                                             | No, shown only. Hermes owns its skills, and Clawboo rewrites `mcp.json` on every run.                                                                                                           |
| Claude Code | Clawboo's servers attached to Claude Code, and Claude Code's built-ins                                                                                                                              | No, shown only.                                                                                                                                                                                 |
| Codex       | Clawboo's four servers attached to Codex, and Codex's built-ins                                                                                                                                     | Not at present. Each server row always reads **Pending auth**, even after you sign in, with a disabled **Enable** and a hint to run `codex login`. Clawboo refuses any change to these entries. |
| OpenClaw    | The Gateway's `tools.allow` and `tools.deny` lists, its MCP servers and plugins, and OpenClaw's built-ins                                                                                           | Partly. Allow and deny entries can be switched, and Clawboo asks the Gateway to make the change. Other servers and plugins are shown only, and so are Clawboo's own servers registered there.   |
| Connectors  | The connectors Clawboo is running for you, from the Connectors page                                                                                                                                 | Not from this panel. Connect and disconnect on the [Connectors](/using/connectors) page.                                                                                                        |

## Connectors and grants

Connecting a connector makes it available, but gives it to no agent. An agent reaches a connector only through a **grant**: your permission for that agent to use it, with an access level and a rule for when to ask you first. You manage grants on the Org chart; [Connectors](/using/connectors) has the steps.

On the Org chart, each Boo's tiles show its own entries plus the entries its runtime shares with every agent, such as built-ins. A connector tile appears on a Boo only when that agent holds a grant for it. A connector whose list of tools has changed since you approved it shows **Changed since you approved it**. Read what changed before you trust it again, rather than signing in again.

## What you control

- **Switch entries on or off**: in the Capabilities panel, for entries Clawboo owns and for OpenClaw's allow and deny entries. See [Capabilities](/using/capabilities).
- **Add skills**: install them from the [Marketplace](/using/marketplace).
- **Add connectors and decide who uses them**: connect on the Connectors page, then give agents access on the Org chart. See [Connectors](/using/connectors).
- **Approve tool calls**: answer the approvals waiting at the top of the panel, or in [Approvals](/using/approvals).

## Limits

- Clawboo never changes Hermes skills, or your own Claude Code settings in `~/.claude`.
- OpenClaw's MCP servers and plugins cannot be switched from Clawboo; change them in OpenClaw.
- Codex entries cannot be changed from Clawboo.
- Clawboo cannot tell OpenClaw agents apart, so the connectors you give an OpenClaw agent on the Org chart do not reach it. Its use of apps through Composio asks for your approval each time.

<Accordion title="Under the hood">

- **The record.** Each entry is a `CapabilityRecord`. Its `id` has the form `<source>:<runtime>:<scope>:<agentId or global>:<kind>:<key>`, and it carries `kind`, `scope` (`agent` or `global` in practice), `manageability`, `status`, `available`, `writable`, `hint`, `health` (`unknown`, `ok`, `needs-auth`, `degraded`, `error` or `drift`) and, for granted connectors, `grantId`.
- **Manageability.** `managed`: Clawboo owns it. `external-write`: the runtime owns the store and Clawboo would write through it (Codex, blocked today). `runtime-of-record`: the runtime owns it and Clawboo asks the runtime to change it (OpenClaw allow and deny lists). `observe-only`: read only.
- **Writes.** The REST handler refuses an enable or disable on an `observe-only` or non-writable entry with `422`, and an unknown entry with `404`. The panel hides more buttons than that: it offers none for unavailable or pending-auth entries either. An install takes the owning runtime from the agent's own record, never from the request.
- **Degraded sources.** Each source's last good read is kept in the `capabilities` table. When a source fails to read, its cached rows are served instead, and fresh rows win when both exist.

See the [Capabilities API](/reference/rest-api/capabilities) and the [packages overview](/reference/packages/index).

</Accordion>

## Related

- [Capabilities](/using/capabilities): the Capabilities panel, step by step.
- [Connectors](/using/connectors): connect apps and servers, and give agents access.
- [Org chart](/using/org-chart): every team's Boos and their capability tiles.
- [Teams, rooms and runtimes](/concepts/teams-and-planes): what each runtime keeps to itself.
- [Memory](/concepts/memory): the other shared resource every teammate uses.
