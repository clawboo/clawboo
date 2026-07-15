---
title: 'Set up governance: budgets, caps, and approvals'
description: A walkthrough for putting a USD budget on a team, watching the kill-switch pause at the cap, and resolving risky-delegation approvals.
---

This guide walks you through turning Clawboo's spend governance from its default _track-and-warn_ posture into real enforcement: you set a USD budget on a team, watch a `cap`-mode budget auto-pause a run the moment it crosses 100%, and resolve a risky-delegation approval. Along the way you will see how the always-on circuit breakers and depth/fan-out caps already protect you for free.

It composes existing surfaces. The mechanics live in [Governance](/concepts/governance); the human-facing panel is [Use the Governance dashboard](/using/governance-dashboard); the raw shapes are in the [Governance API reference](/reference/rest-api/governance). This guide ties them into one operator task and links out for detail rather than restating it.

<Note>
If you have not deployed a team yet, do [Deploy your first team](/getting-started/first-team) first. This guide assumes you have a team whose agents incur cost; governance only does something once runs produce `cost` events.
</Note>

## What you are setting up

Clawboo has four governance mechanisms, and they sit at two different layers:

| Mechanism                         | Layer                                     | On by default?                         | What you do here                                  |
| --------------------------------- | ----------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| **Budgets**                       | Run-local, in the executor cost loop      | On, but **uncapped**                   | Create one, in `cap` mode, to get the kill-switch |
| **Circuit breakers**              | Run-local, in the executor cost/tool loop | On, conservative defaults              | Understand them, nothing to configure             |
| **Caps** (depth / fan-out / cost) | Orchestrator boundary                     | On, conservative defaults              | Understand them; read them in the dashboard       |
| **Approvals**                     | Orchestrator boundary                     | On (only _risky_ delegations reach it) | Resolve one when it appears                       |

Every one of these keys on a typed [`RuntimeEvent`](/appendices/glossary): a `cost` event's dollar delta, a `tool-call`/`tool-result` pair, a typed error `code`, never on the model's rendered prose. That is the same no-prose-as-control-signal rule the whole [orchestration](/concepts/delegation-and-orchestration) layer follows. You cannot turn governance off; you can only opt into _harder_ enforcement (a `cap` budget, a per-run cost ceiling). Full reasoning in [Governance § design rationale](/concepts/governance#design-rationale-and-trade-offs).

## Prerequisites

- A running dashboard. The Governance panel polls `/api/governance/budgets` every 5 seconds. See [Installation](/getting-started/installation).
- The **Governance** nav view open (`GovernancePanel`). There is no flag to enable it.
- Your resolved API port for any `curl` examples; the default is `18790`, with auto-fallback through `18809`. See [Deployment § ports](/operating/deployment).
- A team id (or agent / root-task id) to scope the budget to. Grab a team id from `GET /api/teams` or the team header.

## Steps

### 1. Confirm the default posture (nothing pauses yet)

Out of the box no budget row exists, so the kill-switch enforces nothing. Confirm it:

```bash
curl http://localhost:18790/api/governance/budgets
```

A fresh install returns `{ "budgets": [] }`. An empty list means _uncapped_, not _zero_; "uncapped" is the absence of a budget row, never a `$0` limit. You still get the always-on tracking, the [audit log](/using/governance-dashboard#7-search-the-audit-log), and the circuit breakers for free; budgets are the one piece you opt into.

### 2. Create a budget in `cap` mode

A budget is a USD cap on a **scope**. There are four:

| Scope     | What it bounds                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `agent`   | One agent's lifetime spend.                                                                                           |
| `mission` | One delegation tree's spend, the _root_ task of the tree. Spend rolls up here so one tree can't drain the org budget. |
| `team`    | A whole team's spend.                                                                                                 |
| `tenant`  | Dormant per-org seam (see [Boundaries](#boundaries)).                                                                 |

The mode is the difference between _watching_ a budget and _enforcing_ one:

- **`warn` (the shipped default).** Records spend and emits a warning at the 80% and 100% crossings, but its status never reads `paused`, so the kill-switch leaves the run alone.
- **`cap`.** Identical tracking, but the 100% crossing persists `status = 'paused'` and the kill-switch aborts the live run.

From the dashboard's inline create form: pick the **scope** (`team`), type the **scope id** (your team id), enter the **limit** in dollars, pick **hard cap**, and click **Set budget**. The form converts dollars to cents (`Math.round(v * 100)`) and `POST`s `{ scope, scopeId, limitUsdCents, mode }`.

The equivalent REST call: a `$5.00` hard cap on a team (`500` cents):

```bash
curl -X POST http://localhost:18790/api/governance/budgets \
  -H 'Content-Type: application/json' \
  -d '{"scope":"team","scopeId":"<team-id>","limitUsdCents":500,"mode":"cap"}'
```

The new row starts at `spent 0 / active`. Note two validation rules baked into the schema:

<Info>
`limitUsdCents` must be a **positive integer** (`z.number().int().positive()`). A cap of `$0` is rejected with `400 { "error": "invalid body" }`. If you omit `mode`, the budget defaults to `warn`; you must pass `"mode":"cap"` to get the auto-pause. Full body shape: [`POST /api/governance/budgets`](/reference/rest-api/governance#post-apigovernancebudgets).
</Info>

### 3. Watch the kill-switch pause at 100%

Now dispatch work that spends past the cap (run a task on the team, or let the team chat drive a delegation). Spend is recorded _inside_ the executor's cost loop, not over REST: on every `cost` event the runner records the dollar delta against all three concrete scopes atomically: `agent`, the `mission` (the root task of the delegation tree), and `team`.

```ts
const a = recordSpend(db, 'agent', assigneeAgentId, ledgerCents)
const m = missionId ? recordSpend(db, 'mission', missionId, ledgerCents) : null
const t = task.teamId ? recordSpend(db, 'team', task.teamId, ledgerCents) : null
```

`recordSpend` is an atomic read-modify-write under `BEGIN IMMEDIATE` (the board's [contention recipe](/concepts/the-board#the-contention-recipe)), so two concurrent cost events can never lose an update. The moment a `cap`-mode scope's recorded spend crosses 100%, the runner sets `stopForBudget`, aborts the live run, and runs one teardown:

1. An `auto_pause` entry lands in the [governance audit log](/using/governance-dashboard#7-search-the-audit-log) (`eventType: 'budget'`).
2. A system comment is added to the board task: _"Auto-paused: `<team>` budget reached. Raise the cap (or resume) to continue."_
3. The execution is completed as `cancelled` with error `budget_paused:<scope>`, and an `execution_completed` observability event fires.
4. The task is **released to `todo`**, retryable once you raise the cap or resume.

The budget row's status flips to `paused`. In the dashboard its status pill turns red; over REST:

```bash
curl http://localhost:18790/api/governance/budgets
# the team row now reads "status": "paused"
```

<Note>
The runner double-guards this: the DB layer clamps a `warn` budget's status so it can never read `paused`, and the kill-switch *additionally* checks `mode === 'cap'` explicitly. A `warn` budget can never auto-pause even if the DB clamp regressed.
</Note>

Two precision details keep the ledger honest while you watch it climb:

- **Sub-cent carry.** A cost event can be a fraction of a cent. Spend accumulates in _micro-cents_ (`MICRO_CENTS_PER_CENT = 10000`) so repeated tiny amounts are not floored to zero; the displayed `spentUsdCents` is `floor(spentMicroCents / 10000)`.
- **Estimated cost for runtimes without USD.** A runtime that reports tokens but no dollar figure (Codex, Hermes, an unpinned native model) emits `costUsd: null`; the runner estimates spend from exact token usage × the model rate so the cap still engages. A real `costUsd` (Claude Code, a pinned native model) is used as-is.

### 4. Resume the paused scope (raise the cap, don't just un-pause)

A `paused` budget shows a **Resume** button. Clicking it forces the scope back to `active`, but a _bare_ resume of a scope whose spend already meets its limit re-pauses on the very next cost event.

<Warning>
A bare resume re-arms the kill-switch without granting headroom. When you resume an at-or-over-limit scope, the route returns `willRepause: true` and the dashboard shows an error toast. To make real forward progress, **raise the cap** instead of (or alongside) resuming.
</Warning>

Two ways to make progress:

- **Raise the cap.** Re-`POST` the same `/api/governance/budgets` route with a higher `limitUsdCents` (the dashboard's per-row **Set cap** button). Re-setting the limit recomputes status from the _existing_ spend, so raising the cap above current spend un-pauses the scope.
- **Resume with grace.** The resume route takes an optional `graceUsdCents` body that raises the cap to `spent + grace` in one call:

```bash
# Resume a paused team budget and grant $1.00 of headroom
curl -X POST http://localhost:18790/api/governance/budgets/team/<team-id>/resume \
  -H 'Content-Type: application/json' \
  -d '{"graceUsdCents":100}'
```

The dashboard's Resume button sends a _bare_ resume (no grace); the grace path is REST-only. Both are documented in [`POST .../resume`](/reference/rest-api/governance#post-apigovernancebudgetsscopescopeidresume).

### 5. Understand the circuit breakers (no setup needed)

The breakers are a deterministic, cross-runtime **backstop** for a run that is going nowhere, distinct from the budget kill-switch (which stops on _dollars_) and from a runtime's own max-turns limit. They halt a run that burns turns or tokens making no progress or repeating a failing call, _before_ the dollar ceiling is reached. The breaker is a pure stateful reducer (`stepBreaker`) over run-local state; it does no I/O and reads no wall clock.

There are five trip reasons, all with conservative defaults a healthy run never trips:

| Reason                 | Fires when                                                                        | Default                           |
| ---------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| `iteration-cap`        | Settled tool-calls in one run exceed the ceiling.                                 | `> 30`                            |
| `repeat-failure`       | The same _failing_ tool signature (name + hash of typed input) N times in a row.  | `≥ 3`                             |
| `no-progress`          | N tool-results that add no _new_ successful output.                               | `≥ 6`                             |
| `token-velocity`       | Tokens-per-minute exceeds the ceiling over a window of at least the minimum span. | `> 200,000` / min, `≥ 15s` window |
| `repeat-policy-denied` | The same typed policy-denial `code` N consecutive times.                          | `≥ 2`                             |

When a breaker trips, the teardown mirrors the budget teardown exactly: a `circuit_break` audit entry, a `[stopped: <reason>] … Released to todo for re-planning.` board comment so the leader can re-plan, a `cancelled` execution with error `circuit_broken:<reason>`, and a release to `todo`. The worktree is left intact, so the [handoff](/concepts/worktrees-and-handoff) stays writable and a retry resumes from clean state.

You can override the breaker thresholds per run via the `breakerConfig` field on `POST /api/runtimes/:id/run` (validated by a zod schema; each field optional, falling back to the conservative default). A per-team or per-agent override table is a noted future seam. Full nuance, why `no-progress` only counts failures, why `token-velocity` needs two cost events, is in [Governance § the circuit breakers](/concepts/governance#the-circuit-breakers).

### 6. Read the enforced-in-code caps

The **Caps (enforced in code)** section of the dashboard is informational; these are stateless predicates enforced at the orchestrator boundary, refusing a delegation _before_ it becomes a board task and a run. They are not editable from the UI.

| Cap         | Bounds                                                              | Default                 |
| ----------- | ------------------------------------------------------------------- | ----------------------- |
| **depth**   | How deep a delegation tree may grow.                                | `2`                     |
| **fan-out** | How many parallel delegations _one turn_ may spawn.                 | `8`                     |
| **cost**    | A single run's accrued cent ceiling, independent of any budget row. | opt-in (`maxNodeCents`) |

- The **depth cap** is the single-reduce-point rule: a leader delegates to a specialist who can delegate once more, and no further. The orchestrator computes depth from the board's `parent_task_id` ancestor chain, not from a prompt, and refuses a delegation that would exceed it (the runner refuses with reason `too_deep`), leaving a system comment and a reflection telling the delegator to handle the work directly.
- The **fan-out cap** counts the delegations spawned in one turn. At the max, the overflow is dropped with a comment naming how many were not started.
- The **cost cap** (`maxNodeCents`) is a per-run cent ceiling. Crossing it sets `stopForBudget = 'node'`, the same teardown as a budget auto-pause. It accumulates the same estimated/real cents the budget ledger sees.

A cap hit is logged to the audit log with event type `cap_hit`.

### 7. Resolve a risky-delegation approval

Some delegations should not run until a human signs off, a destructive or external action a leader is about to hand to a specialist. The orchestrator gates these on the leader's approval queue. A client-side heuristic decides which delegations are risky (matching obviously destructive or external verbs like `delete`, `deploy`, `publish`, `rm -rf`, `prod`, `secret`, `force-push`).

When a risky delegation fires, it calls the delegation-approval endpoint, which reuses the existing DB-mediated `tool_call_approvals` handshake:

1. **Sticky scope.** If the leader has previously resolved an `allow_always` for this scope key (`delegate:<kind>`), the prompt is skipped and the approval returns immediately.
2. **Otherwise, a pending approval is created** and the handler _blocks_ on a poll loop until the leader resolves it via the Approvals UI, or until the TTL or the waiter deadline expires.
3. **The resolution decides.** `allow_once` or `allow_always` lets the delegation proceed; anything else (`deny`, `expired`, `timeout`) skips it, leaving a system comment and a reflection so the leader can revise or reassign.

To resolve one, open the **Approval queue** in the Governance panel (the _same_ shared `ToolApprovalQueue` as the [Approvals panel](/using/approvals), so there is one resolve path). Each pending row shows the tool name, an expiry countdown, the reason, and an args summary, with **Allow Once** / **Always** / **Deny**. These `POST` to `/api/tools/approvals/:id/resolve`.

<Info>
The client-side delegation-approval call **fails closed**. If the approval endpoint is unreachable, the request maps to `timeout`, a non-approving resolution, never `allow_once`. The whole point of the gate is human sign-off for a destructive action, so an unreachable endpoint must not auto-approve. Only *risky* delegations reach this path, so the strictness can never deadlock ordinary team work.
</Info>

A forgotten approval **times out rather than deadlocks**: each approval carries an `expiresAt`, the waiter has its own deadline, and a durable TTL reaper atomically expires abandoned pending approvals on an interval (and unblocks the linked board task). The TTL is configurable via `CLAWBOO_APPROVAL_TTL_MS`; see [environment variables](/reference/environment-variables).

## Verify it worked

- **A new or raised budget** appears (or updates) in the Budgets list within the 5-second poll. Confirm over REST with `curl http://localhost:18790/api/governance/budgets`.
- **A `cap`-mode scope that crossed 100%** reads `"status": "paused"` and shows a red status pill plus the auto-pause audit entry and the `budget_paused:<scope>` board comment.
- **A resumed scope** flips its status back to `active`. If it shows `will re-pause`, raise the cap.
- **A resolved approval** disappears from the Approval queue on the next 3-second refetch, and the gated delegation proceeds (or is skipped on a deny).
- **The audit log** carries the trail: filter `GET /api/governance/audit?eventType=budget` for the budget events, `eventType=cap_hit` for a cap hit, `eventType=circuit_break` for a tripped breaker.

## Troubleshooting

<Warning>
**A `warn`-mode budget never stops a run.** It records spend and warns at 80% / 100%, but its status never reads `paused`, so the kill-switch ignores it. If you want runs to actually stop, create the budget in `hard cap` mode. The dashboard's **Set cap** button *preserves the row's current mode*; to switch a `warn` row to `cap`, re-create it in the create form with `hard cap` selected.
</Warning>

<Warning>
**A `cap`-mode budget keeps re-pausing right after Resume.** That is expected when spend already meets or exceeds the cap; a bare resume re-arms the kill-switch and the next cost event re-pauses it. Raise the cap (step 4) above the current spend so there is real headroom.
</Warning>

<Danger>
**Setting a `$0` budget does nothing.** The `POST` is rejected with `400 invalid body`; a cap must be a positive cent amount. "Uncapped" is the *absence* of a budget row, not a `$0` limit. There is no delete route; to make a scope uncapped again, leave it without a row.
</Danger>

<a id="boundaries"></a>

<Note>
**The OpenClaw path records spend at the terminal, so it cannot auto-abort mid-run.** OpenClaw emits no incremental cost events (only a final cost on `done`), so there is no per-event crossing signal for the budget kill-switch to fire on during a run. Its budgets are instead enforced by a *pre-flight gate* on the **next** dispatch (the runner refuses a dispatch with reason `budget_paused` before the claim when a relevant `cap`-paused budget already exists), not a mid-run kill. This is a documented asymmetry with runtimes that stream per-turn cost (like the native runtime). The `tenant` scope and `tenantId` column are a dormant future seam; Clawboo runs as a single implicit tenant in v0.3.0.
</Note>

## Related

- [Governance](/concepts/governance): budgets, the kill-switch, circuit breakers, caps, and approvals explained
- [Use the Governance dashboard](/using/governance-dashboard): the panel, step by step
- [Governance API reference](/reference/rest-api/governance): full request/response shapes for budgets, resume, audit, and delegation approval
- [Verification](/concepts/verification): the builder-≠-judge gate that makes "done" mean _verified_
- [Cost and budgets](/using/cost-and-budgets): the cost dashboard alongside budgets
- [Production defaults](/operating/production-defaults): why track-and-warn is the default posture
- [Approvals](/using/approvals): the same tool-approval queue surfaced standalone
- [Build a multi-runtime team](/guides/multi-runtime-team): the team this governance protects

## See also

- [Worktrees and handoff](/concepts/worktrees-and-handoff): the isolation boundary governance complements
- [Observability](/concepts/observability): the event log and audit trail governance writes into
- [Environment variables](/reference/environment-variables): `CLAWBOO_APPROVAL_TTL_MS` and the reaper interval
- [Glossary](/appendices/glossary): canonical term definitions
