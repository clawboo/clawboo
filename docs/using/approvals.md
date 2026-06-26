---
title: Review and resolve approvals
description: Use the Approvals panel to allow or deny pending exec approvals and the shared tool/delegation queue, team-scoped.
---

Use this page when an agent pauses for your decision: an OpenClaw exec command waiting on a gate, or a brokered tool call / risky delegation queued for a human. Both surface in the **Approvals** panel, where you resolve each with **Allow Once**, **Always Allow**, or **Deny**.

The panel renders two distinct surfaces that look alike but are wired differently:

- **Exec Approvals**: OpenClaw's command-execution gate. Requests arrive over the live Gateway connection; you resolve them back through the Gateway, and the decision is also logged to Clawboo's history table.
- **The shared tool-approval queue**: Clawboo's own database-mediated handshake for brokered tool calls and risky delegations. The same queue (and the same resolve buttons) is reused by the [Governance dashboard](/using/governance-dashboard), so there is one resolve path, not two.

Below those, the panel lists the broker's tools with their availability, so you can see at a glance which tools are reachable.

## Prerequisites

<Note>
The Approvals panel is always available; it is one of the nav views. Whether anything appears depends on whether an agent is configured to ask before acting.
</Note>

- Open the **Approvals** view: click **Approvals** in the sidebar nav (the lock icon), or press **Cmd/Ctrl + 3**. The nav button shows a badge with the pending exec-approval count.
- For **exec approvals** to appear, the agent's command-execution policy must be set to ask. Open an agent, go to the **Personality** tab → **Execution Permissions**, and set **Command Execution** to **Always Ask** or **Ask for Unknown**. Then ask the agent to run a command. It pauses and the request appears here.
- For **tool / delegation approvals**, no extra setup is needed; the broker writes a pending row when a risky or availability-gated tool call needs sign-off, and the governance delegation gate writes one for a risky delegation.

## Steps

### 1. Open the panel and read the pending items

The panel is team-scoped. When a team is selected, exec approvals are filtered to that team's agents (requests with no `agentId` always show); selecting **no team** shows all. Exec approvals are sorted oldest-first.

Each **exec approval** card shows:

- An amber "Exec Approval" label with a pulsing alert dot.
- The owning agent's name and a live `expires Ns` countdown (the Gateway times an unresolved request out after roughly 120 seconds).
- The command in a code block, plus any of `cwd`, `host`, `path`, and `security` as detail rows, and an error line if the request carried one.

Each **tool / delegation approval** card (in the queue below) shows:

- The tool name in accent red and a live `expires Ns` countdown.
- An optional reason line and an optional args summary (credential-shaped fields are masked before display).

### 2. Resolve each item

Click one of the three actions on the card:

| Action           | Exec approval                                        | Tool / delegation approval                             |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| **Allow Once**   | Permits this single run                              | Permits this single call (`allow_once`)                |
| **Always Allow** | Allowlists the command pattern so it stops prompting | Records a sticky allow for this scope (`allow_always`) |
| **Deny**         | Rejects the run                                      | Rejects the call (`deny`)                              |

What happens under the hood differs by surface:

- **Exec approval.** The decision goes to the Gateway via `exec.approval.resolve`, then (when the agent is known) is persisted to Clawboo's history through `POST /api/approvals`. The card buttons disable while the decision is in flight. After an allow, Clawboo runs a deterministic followup to recover the command's output in webchat-only setups where the Gateway's own delivery would otherwise drop it.
- **Tool / delegation approval.** The decision is written to the `tool_call_approvals` row via `POST /api/tools/approvals/:id/resolve`. The broker (or the delegation gate) is long-polling that row in another process, so it unblocks the moment you resolve. The queue re-polls every 3 seconds, so the card clears on its own.

<Note>
Resolving the same tool/delegation row twice is a no-op; the resolve is guarded on `status='pending'`, so a stale double-click can't flip an already-decided approval. An exec approval that has already expired Gateway-side resolves silently (the card just disappears) rather than showing a confusing error.
</Note>

### 3. Watch the per-Boo indicator

While a Boo has an exec approval pending, its node in the [Ghost Graph](/using/ghost-graph) shows a pulsing **amber ring**, a circle when the Boo is idle, a rounded outline when it is rendered as an active card. The ring is matched by `agentId`, so it points at exactly the Boo waiting on you. It clears the instant you resolve.

## What the cards report

### Exec approval card

| Field                                | Source                                                         | Notes                                              |
| ------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------- |
| Agent name                           | Resolved from `agentId` (or the session key) against the fleet | Falls back to the raw `agentId` or "Unknown Agent" |
| `command`                            | The request payload                                            | Shown in a code block                              |
| `cwd` / `host` / `path` / `security` | The request payload                                            | Rendered as detail rows only when present          |
| `expires Ns`                         | `expiresAtMs − now`                                            | Counts down to the ~120 s Gateway timeout          |
| error                                | The request payload                                            | Red line, shown only if set                        |

### Tool / delegation card

| Field         | Source                        | Notes                                |
| ------------- | ----------------------------- | ------------------------------------ |
| `toolName`    | The `tool_call_approvals` row | Accent-red header                    |
| `reason`      | The row                       | Optional human-readable rationale    |
| `argsSummary` | The row (scrubbed JSON)       | Re-masked at display time; truncated |
| `expires Ns`  | `expiresAt − now`             | The approval's own TTL               |

<Info>
The two surfaces write **different tables and have different decision strings.** Exec approvals use `allow-once` / `allow-always` / `deny` (with hyphens) into the `approval_history` log; tool/delegation approvals use `allow_once` / `allow_always` / `deny` (with underscores) into `tool_call_approvals`. The buttons read the same in the UI; the wire values differ.
</Info>

## Tool availability (read-only)

Under the queue, the panel lists every broker tool with an **Available** / **Unavailable** pill, sourced from `GET /api/tools`. A tool is unavailable when an availability requirement (auth, config, env, or plugin) is unmet; the card greys out and its tooltip shows the diagnostics. A non-`safe` risk tool also shows an amber warning icon. This is informational; there are no actions here; it tells you which brokered tools an agent can actually reach.

## Verify it worked

- The resolved card disappears. For an exec approval, the count badge on the **Approvals** nav button drops by one and the Boo's amber ring clears in the Ghost Graph.
- For an exec **allow**, the agent resumes and (after the followup) reports the command's output back into the chat transcript.
- For a tool/delegation approval, the waiting tool call / delegation proceeds (on allow) or is rejected (on deny) within a few seconds.
- The decision history is queryable: `GET /api/approvals?agentId=<id>` returns the persisted exec-approval decisions for that agent (most recent first).

## Troubleshooting

<Warning>
**A card vanished before you resolved it.** Exec approvals expire Gateway-side at ~120 seconds and the queue removes expired rows; if you do not act in time, the request lapses (an exec lapse is a non-decision, not a deny). Resolve promptly, or set the agent's policy to **Ask for Unknown** so only unfamiliar commands prompt.
</Warning>

<Warning>
**The agent allowed a command but produced no output.** In webchat-only setups the Gateway's internal `deliver:true` followup can drop the output. Clawboo runs a best-effort recovery that re-sends the command with `deliver:false`; if it still does not land, ask the agent to run the command again.
</Warning>

<Danger>
**Always Allow is sticky.** For an exec approval it allowlists the command pattern so it stops asking; for a tool/delegation it records a sticky allow for that scope. Use **Allow Once** when you want to keep the gate for next time.
</Danger>

## Related

- [Governance](/concepts/governance), how budgets, circuit breakers, caps, and approvals form the guardrail layer
- [Governance dashboard](/using/governance-dashboard), reuses the same tool-approval queue
- [The Ghost Graph](/using/ghost-graph), where the per-Boo pending-approval ring renders
- [`/api/governance` reference](/reference/rest-api/governance), the `/api/approvals`, `/api/tools/approvals`, and delegation-approval shapes
