---
title: Cost and budgets
description: Track token usage on the Cost dashboard and set USD budgets (warn or cap) per agent, mission, or team from Governance.
---

Use this page when you want to see what your fleet is spending and put a USD ceiling on it. Clawboo splits this into two surfaces:

- The **Cost** view (labelled **Tokens Used**) is a read-only usage report: tokens today / this week / this month, a per-team and per-agent breakdown, and a 30-day trend.
- The **Governance** view is where you set **budgets** in real dollars. A budget is scoped to an `agent`, `mission`, `team`, or `tenant`, and runs in one of two modes: `warn` (track-and-warn, never stops a run) or `cap` (a hard cap that the executor auto-pauses when spend crosses 100%).

The two surfaces read different stores. The Cost dashboard reads the `cost_records` table (token ledger, surfaced through `/api/cost-records/summary`). Budgets live in the `budgets` table and the spend that drives them is accumulated by the executor at run time, separately from the token ledger. Setting a budget does not change anything the Cost dashboard shows, and vice versa.

<Note>
The Cost view is global on purpose; it shows every team's usage, not just the selected team. Budgets are per-scope.
</Note>

## Prerequisites

- Clawboo is running and you can reach the dashboard.
- For the Cost view to show anything, at least one cost record must exist. Records are written by `POST /api/cost-records` (`{ agentId, model, inputTokens, outputTokens, runId? }`) as runs complete; a fresh install shows the empty state until your Boos have done some work.
- Budgets enforce USD, but token usage on the Cost view is never gated by a budget; they are independent.

## The Cost dashboard (Tokens Used)

Open it from the **Cost** nav button. The toolbar reads **Tokens Used**; the body is "Token usage by team and agent."

![Clawboo dashboard showing teams and live agent activity](/images/team-space.png)

### Summary cards

Three cards across the top, **Today**, **This Week**, **This Month**, each showing a single token count (`tokensToday`, `tokensWeek`, `tokensMonth` from the summary endpoint). The number is color-coded by magnitude: mint under 10k tokens, amber under 100k, accent-red at 100k and above. These are token counts, not dollars.

### Tokens by Team

A collapsible breakdown grouped by team. Every fleet agent appears, even one with zero recorded usage, so the breakdown stays in sync with your actual fleet rather than only listing agents that happen to have cost records. Within a team, agents sort by token count, descending; teams sort by total tokens, with **Unassigned** (teamless agents) last.

Each agent row shows a proportional token bar (its share of the team total) and an `input / output` token split. Hovering the split shows the exact in/out counts.

### Token Usage: Last 30 Days

A line chart of daily token totals over the trailing 30 days. The series is dense: every one of the 30 days is present, with empty days filled at zero, so the line is continuous even when usage is sparse.

<Note>
The dashboard is token-first. The underlying records also carry a `costUsd` value (computed from a per-model price table when each record is written), and the summary endpoint returns per-period USD totals (`totalToday` / `totalWeek` / `totalMonth`) and a per-agent `totalCost`, but the current UI surfaces tokens. To enforce a dollar ceiling, use a budget (below).
</Note>

## Setting a USD budget

Open the **Governance** nav button. The toolbar shows **Governance** and a `N budgets` pill. The **Budgets** section is where you create, raise, and resume budgets.

The default posture is **track-and-warn**: out of the box nothing pauses your agents. You choose the posture per budget when you create it.

| Mode   | Behavior                                                                                                           | When to use                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `warn` | Records spend and emits a warning event at the 80% and 100% crossings, but never stops a run. This is the default. | You want visibility without risk of a stuck run. |
| `cap`  | A hard cap. The executor auto-pauses the run the moment any scope crosses 100%; this is the budget kill-switch.    | You want a real spend ceiling enforced.          |

### Steps

1. Open **Governance** → **Budgets**.
2. In the create row, pick a **scope**: `agent`, `mission`, `team`, or `tenant`.
3. Enter the **scope id** (the agent id, mission/root-task id, team id, or tenant id this budget applies to).
4. Enter the dollar amount in the limit field. The placeholder reads "warn at $" in warn mode and "cap $" in cap mode. The value is converted to integer cents on submit (`Math.round(dollars * 100)`).
5. Choose the mode in the **warn only / hard cap** dropdown. The default is **warn only**.
6. Click **Set budget**.

The new budget appears as a row showing its scope chip, scope id, a mode pill (`warn` or `cap`), a status pill, a `spent / cap` line in dollars, and a percent-of-cap progress bar.

<Info>
The limit must be a positive whole-cent amount. A cap of `$0` is rejected (`400 invalid body`); "uncapped" is the *absence* of a budget row, not a zero limit. The smallest valid limit is one cent.
</Info>

### What the backing route does

`POST /api/governance/budgets` validates the body `{ scope, scopeId, limitUsdCents, mode?, tenantId? }` with a zod schema. `scope` must be one of the four scope names; `scopeId` must be non-empty; `limitUsdCents` must be a positive integer; `mode` (when present) is `cap` or `warn`. The handler upserts the budget and returns `{ budget }`. An invalid body returns `400 { error: "invalid body", details }`.

Creating a budget for a scope that already exists **raises (or lowers) its cap** rather than erroring; re-setting the limit recomputes status from the existing spend. This is also how you un-pause: raise a hard cap above the current spend and the scope flips back to active.

## Reading a budget row

| Status pill           | Meaning                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `active` (mint)       | Under cap; the run proceeds.                                                                                         |
| `soft_capped` (amber) | At/over a `warn`-mode threshold, or a `cap` budget that was downgraded: spend is recorded but the run is not paused. |
| `paused` (accent-red) | A `cap` budget that crossed 100%. The executor stopped the run. Only a human resume or a raised cap re-opens it.     |

The row also shows the mode pill (`warn` / `cap`) and, when a paused `cap` budget is resumed without grace and is still at/over its cap, a **will re-pause** pill, a warning that the next recorded spend will pause it again unless you raise the cap.

## Resuming a paused budget

When a hard `cap` budget pauses a run, the row shows `paused` and a **Resume** button.

1. Click **Resume** on the paused row.

`POST /api/governance/budgets/:scope/:scopeId/resume` forces the scope back to active. If the spend is still at or over the cap, the response sets `willRepause: true` and the UI raises a toast warning that the budget will pause again on the next cost event. To make real forward progress, raise the cap instead:

2. Type a new dollar amount into the per-row **new cap $** field and click **Set cap**. This raises the limit above the current spend (preserving the row's `warn`/`cap` mode), which recomputes status to active with real headroom.

<Tip>
The resume route accepts an optional `{ graceUsdCents }` body, headroom (in cents) to add above the current spend so the resume actually progresses instead of immediately re-pausing. The panel's **Resume** button calls it without grace (a bare resume); **Set cap** is the explicit "give it headroom" path.
</Tip>

## The caps that are always on

Below the budgets, Governance lists three **caps enforced in code**; these are not USD and are not configurable from the UI:

- **max spawn depth** `2`, how deep a delegation chain can go.
- **max fan-out** `8`, how many parallel delegations one turn can spawn.
- **per-node cost** `per-run`, a per-node cost ceiling applied per run.

A cap hit is logged to the audit feed below the caps (a `cap_hit` event).

## Verify it worked

- **Cost dashboard**: after a run completes, re-open **Cost**. The summary cards and the team breakdown should reflect the new tokens; the 30-day line should pick up today's bucket. The dashboard fetches `/api/cost-records/summary` on mount.
- **Budgets**: the new budget appears in the **Budgets** list (the panel polls `GET /api/governance/budgets` every five seconds). Its `spent / cap` line and percent bar move as runs in that scope record spend. A `cap` budget that crosses 100% flips to `paused`; a `warn` budget never pauses.
- **Audit**: budget threshold crossings, cap hits, and resumes land in the **Audit log** at the bottom of Governance as `budget` / `cap_hit` events. Filter by agent id, event type, or a time window (1h / 24h / 7d / All).

## Troubleshooting

<Warning>
**My warn budget hit 100% but nothing stopped.** That is by design. A `warn` budget only records spend and emits the 80% / 100% warning events; it never pauses a run. If you want enforcement, create the budget in **hard cap** mode (or raise an existing row's cap and re-set it as a cap).
</Warning>

<Warning>
**I resumed a paused budget and it paused again immediately.** A bare resume puts the scope back to active but does not change the cap, so if spend is already at/over the limit the next cost event re-pauses it; the row shows a **will re-pause** pill and the UI toasts a warning. Use **Set cap** (or the resume route's `graceUsdCents`) to raise the limit above current spend.
</Warning>

<Warning>
**The Cost dashboard is empty even though agents have run.** Cost records are written per completed run via `POST /api/cost-records`. If you see "No token records yet," no records have been logged for the period yet; token usage is not retroactively backfilled.
</Warning>

<Danger>
**Setting a budget does not retroactively cap past spend.** A budget meters spend recorded *after* it exists (or against the scope's running total). It is not a refund or an audit of historical cost.
</Danger>

## Related

- [Governance](/concepts/governance), the model behind budgets, the kill-switch, circuit breakers, and caps
- [Governance dashboard](/using/governance-dashboard), the full Governance surface (budgets, audit, caps, approval queue)
- [Observability](/concepts/observability), where spend lands in the event log and traces
- [`/api/governance` reference](/reference/rest-api/governance), full request/response shapes for budgets and audit

## See also

- [Governance concept](/concepts/governance)
- [Governance dashboard how-to](/using/governance-dashboard)
- [Approvals](/using/approvals), the tool/delegation approval queue shared with Governance
