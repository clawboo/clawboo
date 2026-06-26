---
title: Use the Governance dashboard
description: Set budgets, raise caps, resume paused scopes, review the enforced-in-code caps, the approval queue, and the forensic audit log.
---

Use the Governance dashboard when you want to put a USD spend limit on your agents, resume a scope that was auto-paused at its cap, clear the tool/delegation approvals that are blocking a run, or read the forensic audit log of what happened. It is the human-facing surface for Clawboo's trust controls.

The panel lives at the **Governance** nav view (`GovernancePanel`), backed by `/api/governance/*`. It has four sections, top to bottom: **Budgets**, **Caps (enforced in code)**, **Approval queue**, and **Audit log**. This page documents what each does, the options, and how to verify.

For the concepts behind these controls, the budget kill-switch, circuit breakers, and `builder≠judge` verification, see [Governance](/concepts/governance). For the raw request/response shapes, see the [`/api/governance` reference](/reference/rest-api/governance).

## Prerequisites

<Note>
The Governance dashboard is always available; there is no flag to enable. Out of the box no budget exists, so nothing pauses your agents until you create a budget in `cap` mode.
</Note>

- A running Clawboo dashboard (the panel polls `/api/governance/budgets` every 5 seconds and `/api/governance/audit` on each filter change).
- To see budgets do anything, you need agents that incur cost; spend is recorded by the executor loop as runs produce `cost` events.

## The default posture

Clawboo ships **track-and-warn**: nothing pauses your agents out of the box. A budget is a row you opt into per scope, and each budget has a **mode**:

| Mode             | Behavior                                                | When the scope crosses 100%                                                 |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `warn` (default) | Records spend and emits a warning event at 80% and 100% | Status reads `soft_capped`; the run keeps going                             |
| `cap` (opt-in)   | The hard kill-switch                                    | The executor auto-pauses the scope the moment a recorded spend crosses 100% |

The pause-at-cap is automatic in the executor; the UI only **sets** budgets, **raises** caps, and **resumes** paused scopes. The new-budget form defaults to `warn`; choose `hard cap` to opt into auto-pause.

## Steps

### 1. Read the existing budgets

The Budgets section lists every budget row, newest-updated first. The header pill shows the count (`N budgets`). Each row shows:

- The **scope** badge (`agent` · `mission` · `team` · `tenant`) and its **scope id**.
- The **mode** pill (`warn` or `cap`) and the lifecycle **status** pill (`active` → success/mint, `soft_capped` → warning/amber, `paused` → error/red).
- A `spent / cap` line in dollars plus a percentage and a progress bar.
- If a `cap`-mode budget is `active` but already at or over its limit, a `will re-pause` pill: the next recorded spend re-pauses it, so raise the cap to make progress.

If the budgets load fails on the first fetch, the section shows a `Couldn't load budgets` alert with a **Retry** link. A transient poll failure after a good load keeps the last good snapshot.

### 2. Create a budget

Use the inline create form at the bottom of the Budgets section:

1. Pick the **scope** (`agent` / `mission` / `team` / `tenant`).
2. Type the **scope id**, the id of the agent, the root (mission) task, the team, or the tenant the budget applies to.
3. Enter the **limit** in dollars (the placeholder reads `warn at $` or `cap $` depending on the mode).
4. Pick the **mode** (`warn only` or `hard cap`).
5. Click **Set budget**.

The form converts dollars to cents (`Math.round(v * 100)`) and `POST`s `{ scope, scopeId, limitUsdCents, mode }`. A new scope starts at spent 0 / `active`.

<Info>
A budget cap must be a positive integer cent amount. `limitUsdCents` is validated as `z.number().int().positive()`, so a cap of `$0` is rejected with `400`. "Uncapped" is the *absence* of a budget row, not a `$0` limit.
</Info>

### 3. Raise a cap

Every budget row has a `new cap $` input and a **Set cap** button. Enter a new dollar amount and click **Set cap**; it `POST`s the same `/api/governance/budgets` route with the new `limitUsdCents`, preserving the row's mode. Re-setting the limit recomputes status from the _existing_ spend, so **raising the cap above the current spend un-pauses a paused scope**.

### 4. Resume a paused scope

A `cap`-mode budget that crossed 100% reads `paused`, and a **Resume** button appears on its row. Click it to force the scope back to `active` (a human override).

<Warning>
A bare resume of a scope whose spend already meets or exceeds its cap will re-pause on the very next cost event. When that happens, the resume returns `willRepause: true` and the UI shows an error toast: *"Resumed, but spend is still at/over the cap; raise the cap to make progress."* To make forward progress, **raise the cap** (step 3) instead of, or in addition to, resuming.
</Warning>

The resume route accepts an optional `graceUsdCents` body to raise the cap above current spend in one call; the panel's Resume button sends a bare resume (no grace).

### 5. Review the enforced-in-code caps

The **Caps (enforced in code)** section is informational; these limits are enforced in the orchestrator/executor, not editable from the UI:

| Cap             | Value     | What it limits                                                      |
| --------------- | --------- | ------------------------------------------------------------------- |
| max spawn depth | `2`       | How deep a delegation tree can spawn (the single-reduce-point rule) |
| max fan-out     | `8`       | How many parallel delegations one turn can spawn                    |
| per-node cost   | `per-run` | A per-run cost ceiling on a single node                             |

A cap hit is logged to the audit log below (event type `cap_hit`).

### 6. Resolve approvals

The **Approval queue** section embeds the shared `ToolApprovalQueue`, the _same_ queue and resolve UX as the [Approvals panel](/using/approvals), so there is one resolve path. A pending tool-call or delegation approval shows the tool name, an expiry countdown, the reason, and an args summary, with three actions:

- **Allow Once**: approve this one call.
- **Always**: allow-always for this scope.
- **Deny**: reject it.

These `POST` to `/api/tools/approvals/:id/resolve`. The queue polls `/api/tools/approvals?status=pending` every 3 seconds; when empty it shows a "No pending approvals" empty state.

### 7. Search the audit log

The **Audit log** section reads the append-only forensic log: installs, approvals, tool calls, budget events, cap hits, verifications, and circuit breaks. There is no write endpoint; subsystems write the audit in-process as agents run. Filter it three ways (all combine):

- **Agent id**: a free-text input matching `agentId`.
- **Event type**: a dropdown over `install`, `approval`, `tool_call`, `budget`, `cap_hit`, `verification`, `circuit_break` (or `all events`).
- **Since window**: `All` / `1h` / `24h` / `7d` pills (sent as `since = Date.now() - window`).

Each row shows the local time, the event-type badge, a truncated agent id, and the redacted summary. The panel requests `limit: 200`; the route caps `limit` at `1000`. Credential-shaped keys in the summary are masked at the rendering boundary (redact-on-display) on top of the write-time scrub.

## Options / variations

The budget routes accept fields the panel does not surface directly:

| Field           | Route                                                 | Panel exposes it?      | Notes                                                                      |
| --------------- | ----------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `tenantId`      | `POST /api/governance/budgets`                        | No (read-only display) | The dormant per-tenant seam; surfaced on rows as `· tenant <id>` when set  |
| `graceUsdCents` | `POST /api/governance/budgets/:scope/:scopeId/resume` | No                     | Raises the cap to `spent + grace` in one call so the resume makes progress |
| `mode` on raise | `POST /api/governance/budgets` (Set cap)              | Implicitly             | The Set-cap button preserves the row's existing mode                       |

<Note>
`tenantId` and the `tenant` scope are a future seam; the columns exist and are surfaced read-only, but Clawboo runs as a single implicit tenant today.
</Note>

## Verify it worked

- **A new/raised budget** appears (or updates) in the Budgets list within the 5-second poll; its `spent / cap` line, percentage, and mode/status pills reflect the change. You can confirm directly with `curl http://localhost:18790/api/governance/budgets` (use your resolved API port).
- **A resumed scope** flips its status pill from `paused` (red) back to `active` (mint). If it shows `will re-pause`, raise the cap.
- **A resolved approval** disappears from the Approval queue on the next 3-second refetch.
- **An audit entry** for the action lands in the Audit log, e.g. setting/raising a `cap`-mode budget that later crosses produces `budget` events; a cap hit produces `cap_hit`; a verification produces `verification`.

## Troubleshooting

<Warning>
**A `cap`-mode budget keeps re-pausing right after Resume.** That is expected when spend already meets or exceeds the cap. Resume alone re-arms the kill-switch; the next cost event re-pauses it. Raise the cap (Set cap) above the current spend so there is real headroom.
</Warning>

<Warning>
**Setting a `$0` budget does nothing.** The POST is rejected with `400 invalid body`; a cap must be a positive cent amount. To make a scope effectively unspendable, that is not a budget row; remove the row and rely on the per-node cost cap instead.
</Warning>

<Danger>
**A `warn`-mode budget never stops a run.** It records spend and warns at 80% / 100%, but its status never reads `paused`, so the executor kill-switch ignores it. If you actually want runs to stop, create the budget in `hard cap` mode. Note that **Set cap preserves the row's current mode**, so to switch an existing `warn` row to `cap` you re-create it in the create form with `hard cap` selected.
</Danger>

## Related

- [Governance](/concepts/governance), budgets, the kill-switch, circuit breakers, caps, and approvals explained
- [`/api/governance` reference](/reference/rest-api/governance), full request/response shapes for budgets, resume, audit, and delegation approval
- [Approvals](/using/approvals), the same tool-approval queue surfaced standalone
- [Cost and budgets](/using/cost-and-budgets), the cost dashboard alongside budgets
- [Production defaults](/operating/production-defaults), why track-and-warn is the default posture
