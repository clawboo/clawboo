---
title: Scheduling
description: "Routines: Clawboo's durable scheduler for team and agent work, its rebuildable ticker, the two cron domains, the one-firing-owner invariant, and the error-halts policy."
---

A **Routine** is scheduled work: a cron-shaped trigger that, on each fire, hands a team or one agent something to do. A **team routine** posts its instructions into the team's group chat for the team's lead (Boo Zero), which answers or delegates exactly as it would for a message a person typed. An **agent routine** materializes a [board](/concepts/the-board) task for one agent and dispatches it through the same executor pipeline a delegated task would use. Routines are how a team gets recurring or future-dated work, a morning briefing, a nightly report, a one-shot reminder, without anyone sitting at the dashboard to kick it off.

Scheduling in Clawboo holds two things apart that other systems tend to blur: _team-task cron_ (the Routines this page is about) and _runtime-own-life cron_ (a runtime's own standalone scheduler, which Clawboo observes but does not own). It does so on top of a durable ledger that is the source of truth, fronted by an in-process ticker that holds no durable state of its own; kill the process, restart it, and every active Routine reconstructs from SQLite alone.

This page explains the two cron domains, the durable `scheduled_runs` ledger and the rebuildable ticker that drives it, the lifecycle of a single fire, the one-firing-owner invariant that keeps a task from having two schedulers, the error-halts policy that stops a failed Routine instead of retry-burning it, and the unified surface that merges Routines and the OpenClaw Gateway's own cron into one read.

## What it is, and what it isn't

A Routine is **Clawboo's cron for team work**. It owns _when_ a team or an agent is handed work. It is the single external wake for every [runtime](/appendices/glossary) class, native, the wrapped one-shot runtimes (Claude Code, Codex, Hermes), and OpenClaw, so a team built from mixed runtimes has one scheduling surface regardless of what each runtime can do on its own.

A Routine is **not** a runtime's own scheduler. Most runtimes carry some notion of standalone cron or heartbeat; the OpenClaw Gateway, for example, schedules an agent's own life via its built-in cron. Clawboo treats that as a _different domain_: it can read and operate those entries as an operator surface, but it never fires team work into a runtime's own cron, and it never reaches into them to dispatch coordinated team work. The two are surfaced side by side and labeled, never merged.

A Routine is **not** a side channel. A team fire is just another team chat message: it enters through the same server-side ingest a typed message uses, reaches the lead through the same delivery path, and everything the team does in response lands in that chat and on the board. An agent fire is just another task dispatch: it lands on the board, gets atomically claimed, and runs through the executor with budgets, approvals, verification, and observability all applying exactly as they would for a hand-created or delegated task. There is no privileged "scheduled" execution path.

## The two cron domains

The normalized schedule row every source projects carries a `domain` field that keeps the merged view honest. There are exactly two values:

| `domain`           | Who fires it                | Owned by                                    | Example                                                              |
| ------------------ | --------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `team-task`        | Clawboo's Routines engine   | the `scheduled_runs` ledger (`managed`)     | "Every weekday at 9am, post the standup summary to the team chat."   |
| `runtime-own-life` | the runtime's own scheduler | the runtime's own system (`external-write`) | An OpenClaw agent's Gateway cron that wakes _itself_ to check email. |

Both team routines and agent routines are the `team-task` domain: they are work Clawboo coordinates, whichever target they have. The separation is enforced structurally, not by convention. Registering a `team-task` schedule through a `runtime-own-life` source is refused with a typed `TeamTaskDomainViolationError`, both at the multiplexer's gate and again inside the source itself, so the refusal is defense-in-depth. The reasoning: a runtime's own-life cron is the agent's private business, and team cadence belongs to the Routines ledger where the board, budgets, and verification can see it.

## The model

A Routine's durable state lives in the `scheduled_runs` ledger. The ticker reads it, decides what is due _in SQL_, atomically claims each due row, hands the fire to the wake-bridge, and writes the outcome back, re-arming the row for its next occurrence, or disarming it.

```mermaid
flowchart TD
    Ledger[(scheduled_runs ledger)]
    Ticker[Ticker: armed at min next_run_at, ≤60s, or at once for a queued row]

    Ticker -->|due-pass: idle → queued WHERE next_run_at ≤ now| Ledger
    Ledger -->|claim: UPDATE WHERE status='queued' RETURNING| Claim{won?}
    Claim -->|no rows: another ticker won| Drop[Drop, never retry]
    Claim -->|won: claimed → running| Bridge[Wake-bridge]

    Bridge -->|target: team| Chat[Team chat ingest → the team's lead]
    Bridge -->|target: agent| Task[Board task scheduledBy='clawboo']
    Task -->|branch on runtime class| Class{home.kind}
    Class -->|ephemeral / persistent| OneShot[runTaskOnRuntime]
    Class -->|connected| Operator[Operator dispatcher + watchdog]
    Class -->|human| NI[NotImplementedError]

    Chat --> Outcome{outcome}
    OneShot --> Outcome
    Operator --> Outcome
    Outcome -->|success: → idle, re-armed at nextOccurrence| Ledger
    Outcome -->|failure: → error, disarmed| Ledger
```

## The durable ledger

The `scheduled_runs` table is the source of truth. Each row is one Routine: the target `agent_id` and `team_id`, the `cron_spec` string, a `task_template` JSON blob describing what each fire sends, a `status`, the `last_run_at` / `next_run_at` timestamps, a `scheduled_by` firing-owner label, a `last_error`, and the dormant `tenant_id` multi-tenant seam. A team routine stores its team in `team_id` and leaves `agent_id` empty: its fires go to whoever leads the team when they run. An agent routine stores the agent and that agent's own team.

The ledger is deliberately **cron-math-free**. It stores `next_run_at` as a precomputed epoch-millisecond timestamp and never parses a cron expression itself; callers compute the next occurrence and hand it in. This keeps the database package free of any scheduling-library dependency; the single point that imports the cron library lives in the scheduler package's `occurrence.ts`, and everyone else deals in precomputed timestamps.

A `cron_spec` is one of two shapes: a croner-parseable cron expression (5- or 6-field, optionally with seconds), evaluated in the server's local time, or a one-shot `once@<ISO-8601>`. A spent one-shot is self-disabling; after it fires, its `next_run_at` becomes null, and the due-pass only ever queues rows with a non-null `next_run_at`, so the row simply goes quiet.

The `task_template` is a validated JSON object: a `target` (`team` or `agent`; a template without one is an agent routine), a `title` (the routine's name), an optional `description` (the instructions a fire sends), a worktree isolation `kind` (defaulting to `code`), a `priority`, an optional `repoPath` / `model`, an optional `maxNodeCents` cost cap threaded into the run, and an optional `teamTaskId` that binds an agent routine to an _existing_ board task instead of minting a fresh one per fire. Every write that sets a target is validated against the registry: a team routine needs a live team, and an agent routine needs a live agent and is filed on that agent's own team.

### The ledger state machine

A row moves through six statuses, enforced inside the write transaction against the freshly read row (the same discipline the [board](/concepts/the-board) uses):

```
idle ──(next_run_at ≤ now, or Run now)──► queued ──(atomic claim)──► claimed ──► running
                                                                                   ├──► idle  (success, re-armed)
                                                                                   └──► error (disarmed)
idle | queued | error ──(user pause)──► paused   (never auto-fires)
paused | error ──(user resume)──► idle           (re-armed by the caller)
```

`paused` is the one status that **never auto-fires**: the due-pass guards on `status = 'idle'`, so a paused row is invisible to it. A spent one-shot re-enters `idle` with a null `next_run_at` and is equally invisible. An errored Routine sits in `error`, disarmed, until a human resumes it, which is the heart of the error-halts policy below.

## The rebuildable ticker

The ticker is the actuator. It holds _zero_ durable state. Its topology is a single timer, armed at `min(max(minNextRunAt − now, 0), 60s)` and `.unref()`'d so it never keeps the process alive, or at zero delay while a row is already `queued` (a **Run now**, or a fire a restart re-queued). The 60-second clamp does double duty: it is a periodic rescan that picks up rows written by another process and recovers from laptop sleep, and it makes spurious wakes harmless because dueness is always re-decided in SQL.

Each tick runs three phases:

1. **Due-pass.** A single `UPDATE … SET status='queued' WHERE status='idle' AND next_run_at ≤ now RETURNING` flips every due row to `queued`. Paused, errored, and disarmed rows are excluded by the `status='idle'` guard.
2. **Claim phase (sequential).** For each queued row, an atomic `UPDATE … SET status='claimed' WHERE id=? AND status='queued' RETURNING`. A zero-row result means another ticker (or another process) already claimed it; that is **data, not an error**, so the ticker drops the row and never retries. This is the same "never retry a 409" rule the board's claim follows. A won claim emits a `routine_fired` observability event and transitions the row to `running`.
3. **Dispatch phase (concurrent).** The claimed fires are dispatched in parallel under `Promise.allSettled`, so a slow fire never head-of-line-blocks the others, and one failing fire never aborts the rest. Each dispatch records its outcome and re-arms (or disarms) the ledger row.

Only the claim pass is serialized. The ticker re-arms as soon as the claims are made, before the dispatches finish, so a fire still in flight (an agent routine is a whole task run) never holds up the next due Routine; each in-flight row stays `running` until its outcome lands, so no pass can claim it twice. Each landed outcome re-arms the timer against the freshest `min(next_run_at)`, and any REST write to a Routine pokes the ticker to re-arm immediately rather than waiting for the next 60-second rescan. Overlap between fires for the _same_ identity is prevented one layer down: the executor's per-home dispatch mutex, the per-agent mutex for OpenClaw, and the team chat's delivery queue for a team routine.

### Boot-resume: the ledger reconstructs the actuator

Because the ticker holds no durable state, restarting the process loses nothing; but it can leave rows mid-transition (a `claimed` or `running` row from a fire that the previous process started). Boot-resume heals them in one transaction before arming:

- A `claimed` orphan (the fire never started) resets to `queued`; it was due; fire it now. The atomic claim and the board task's own claim deduplicate any double-fire.
- A **recurring** `running` orphan re-arms to `idle` at its next occurrence. The board side of a half-done dispatch is healed separately by the board's own orphan reconciliation.
- A **one-shot** `running` orphan goes to `error`, never re-armed. Its outcome is unknown, and re-firing risks materializing the one-shot twice, so a human inspects it instead.
- `idle` rows are untouched; a past-due `next_run_at` fires on the next due-pass.

A fire cut off this way never records an outcome, so the Routine's run history reports it as `interrupted`.

## The fire path

When a claimed fire is dispatched, the wake-bridge branches first on the Routine's **target**.

### A team fire

A team fire posts the template's instructions (its `description`, or its `title` when there is none) into the team's chat through the server team orchestrator, the same ingest a typed message uses. Like a typed message, instructions that start with an `@mention` go to that member; otherwise the message goes to the team's lead: the install's Boo Zero when there is one, else the team's own lead, else its first active member. Two things set it apart from a typed message:

- The transcript entry carries a `routine` origin (the Routine's id and name), so the chat labels it **Routine** with the Routine's name rather than "You".
- The lead's turn is stamped with a `schedule` origin, and its context gains a scheduled-routine block: nobody may be watching, so it carries the work out and makes reasonable assumptions instead of asking questions and waiting.

The fire succeeds once the lead's turn has started, or queued behind one already running; the team's work then continues in the chat and on the board like any conversation. It fails when the team is gone or archived, has no active members, has opted out of server-side orchestration, or the lead could not be reached. A team fire materializes no board task.

### An agent fire

An agent fire **materializes the board task**: either the existing task the Routine was bound to (which must still be claimable), or a fresh per-fire task stamped `scheduled_by: 'clawboo'`, the firing owner of record. Then it **branches on the runtime's integration class**, read from the adapter's capability seam, never from a hardcoded runtime-id switch:

| Runtime class (`home.kind`) | Runtimes                           | Dispatch path                                                                     |
| --------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `ephemeral` / `persistent`  | native, Claude Code, Codex, Hermes | the standard one-shot executor (`runTaskOnRuntime`)                               |
| `connected`                 | OpenClaw                           | a thin operator dispatcher over the live Gateway connection                       |
| _(human participant)_       | a `participantKind: 'human'` agent | a typed `NotImplementedError`; a future "scheduled board ping," not a spawned run |

The **one-shot path** is the ordinary executor pipeline: claim the board task, run the adapter, verify, and complete. With no `repoPath` in the template there is no repository to branch a worktree from, so the fire runs the way the agent works a task delegated in team chat, without a checkout; a template that names a `repoPath` keeps its `kind`, and a file-changing kind gets a worktree of that repository. A lost claim is treated as success: someone else already owns the task, so the work is happening.

The **connected path** exists because an OpenClaw agent runs over its _live_ Gateway connection; the one-shot runner refuses such a runtime by design. So a separate operator dispatcher claims the board task, opens a stable per-Routine session over the server-held operator client, and drains the adapter's event stream to a terminal `done`, bounded by a watchdog (10 minutes by default, overridable with `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS`). The agent's summary is posted on the task as its report. The watchdog is the documented degradation: a pure dispatch-and-record with no closer would leak `in_progress` board tasks, so on timeout the dispatcher aborts the run and releases the task. Clawboo does **not** create a Gateway cron entry here: that would be the runtime's own-life domain.

When an agent fire fails, the task it minted is set aside: moved from `todo` to `blocked` with a system comment naming the agent and the error. Left in `todo`, it would sit on the board looking like pending work that any agent's `claim_task` could pick up, while the Routine files a fresh task on its next fire anyway. A task bound at registration is the board's own and is left exactly as the runner left it.

Each fire emits a sequence of observability events: `routine_fired` at claim, `routine_dispatched` when the bridge picks a path (`team-chat`, `one-shot`, or `connected`), then `routine_completed` or `routine_error` once the outcome is recorded. Every event carries the Routine's `scheduledRunId`, which is what the per-Routine run history is folded from.

## The one-firing-owner invariant

A board task must have exactly one scheduler. Two schedulers firing the same task is the recipe for double-dispatch, stale claims, and drift. The `tasks.scheduled_by` column carries the firing owner of record; `manual` for a hand-created task, `clawboo` for one the Routines engine fires, `openclaw` (or a future runtime) for a runtime-fired one.

The invariant is enforced at three walls:

1. **Registration-time de-dup (the primary guard).** Binding an agent Routine to an existing team task inspects that task's `scheduled_by`. If it is already owned by a _different_ non-`manual` owner, registration is refused with an `ownership_conflict`, surfaced as a typed `DuplicateFiringOwnerError` (HTTP `409`, never retried). A `manual` task is stamped with the new owner in the same `BEGIN IMMEDIATE` transaction, so two concurrent registrations against one task serialize. Crucially, the guard is **domain-scoped**: it only reads `tasks.scheduled_by` (the team-task domain), so a runtime's own-life cron never trips it.
2. **The atomic claim** is the backstop, even if two firings somehow targeted one task, only one can claim it.
3. **The Gateway source's refusal** is the third wall; a `team-task` create aimed at the runtime-own-life source is refused outright.

Two more registration rules guard subtle pitfalls. A Routine bound to an _existing_ team task may only be a one-shot: a bound task is claimable exactly once (`todo → done`), so a recurring schedule against it would fire once and then park in `error` forever. Binding a recurring spec is refused at registration with a `BoundRecurringScheduleError` (HTTP `400`). And only an agent Routine can bind at all: a team Routine posts to the chat and has no task to claim, so a `teamTaskId` on one is refused with an `InvalidRoutineTargetError` (HTTP `400`).

## The error-halts policy

When a fire fails, the ledger row moves to `error` with the failure recorded in `last_error`, and `next_run_at` is set to null; **disarmed**. It will not fire again until a human resumes it.

This is deliberate. Autonomous scheduled work must never silently retry-burn: a Routine that fails every fire and keeps retrying would spend a budget, churn the board, and bury the real problem. Stopping the Routine surfaces the failure (the Routines view marks it failed, shows the error, and offers Resume) and stops the bleeding. A successful fire, by contrast, re-arms cleanly at its next occurrence; a one-shot self-disables.

A failed dispatch that is _really_ a lost claim is not an error at all, it means another worker already owns the task, the work is happening, and the fire is recorded as satisfied.

## The unified schedules surface

The [Routines view](/using/routines) reads _both_ domains through one merged view. A `ScheduleMultiplexer` fans exactly two `ScheduleSource` adapters:

- **`ClawbooRoutineScheduleSource`**: `domain: 'team-task'`, `manageability: 'managed'`. A thin projection over the `scheduled_runs` ledger; Clawboo fully owns these rows.
- **`OpenClawGatewayCronScheduleSource`**: `domain: 'runtime-own-life'`, `manageability: 'external-write'`. A read+write adapter over the operator's cron RPC on the live Gateway connection; Clawboo operates these but does not own them.

There is deliberately no third source. Claude Code, Codex, Hermes, and native have no live native scheduler that Clawboo drives: scheduling any of them _is_ a Clawboo Routine. The Gateway is the only runtime with an own-life cron Clawboo surfaces.

The trait's contract has a load-bearing property: **`read()` never rejects**. A source whose backend is down (a disconnected Gateway) returns a degraded status with whatever records it can; a stale cache, or none, so one dead source can never take the merged view down. The REST `GET /api/schedules` therefore always returns `200`, with per-source degradation reported as data, and each record is enriched with its team and agent names (for a team Routine, the agent is the team's current lead). Writes route by owner: an `observe-only` source refuses with `403`, a `team-task` create into a runtime-own-life source returns `422`, an unknown id returns `404`, an illegal transition or ownership conflict returns `409`, and a write against a disconnected Gateway returns `503`. The `manageability` tier is a structural gate; the UI is a pure function of it and can never offer an action the owning system forbids.

<Note>
The Routines view reads and writes exclusively through this unified `/api/schedules` surface. Gateway cron jobs are reached server-side via the `OpenClawGatewayCronScheduleSource`; the browser never speaks the Gateway's `cron.*` RPC directly.
</Note>

## Design rationale and trade-offs

The ledger-plus-rebuildable-ticker split is the whole design. Putting durable state in SQLite and keeping the actuator stateless means a crash or restart is a non-event; `bootResume()` reconstructs every active Routine from the rows alone, and deciding dueness in SQL makes the timer's exact wake time irrelevant. The alternative (a stateful in-memory scheduler) would lose its schedule on every restart and need a separate persistence layer anyway.

A team Routine goes through the team chat rather than straight to the board because a team's work is the lead's to divide. Posting to the lead reuses every rule the chat already enforces (routing, delegation, the delivery queue, the transcript), so a scheduled message and a typed one can never drift apart in how they are handled.

Keeping the database package free of the cron library, precomputing `next_run_at` at the caller and storing epoch milliseconds, means swapping the tick library touches exactly one file, and the ledger never grows a scheduling dependency. The cost is that the caller, not the row, owns the cron math; the ticker re-derives the next occurrence after each fire.

The error-halts policy trades autonomy for safety: a Routine that fails stops itself rather than retrying, which means a transient failure needs a human to resume it. For autonomous scheduled work spending real budget, that is the correct default; silent retry-burn is the worse failure mode.

## Boundaries and non-goals

- **Not a runtime's own scheduler.** Clawboo never fires team work into a runtime's own-life cron, and never auto-creates own-life crons. The Gateway-cron source is an operator surface over schedules the Gateway owns, not their owner.
- **No native scheduler for the one-shot runtimes.** Claude Code, Codex, Hermes, and native have no live scheduler Clawboo drives; scheduling them is a Clawboo Routine. `hermes gateway` is deliberately never launched.
- **Human participants are a seam, not a feature.** An agent Routine targeting a `participantKind: 'human'` agent reaches a typed `NotImplementedError`; the intended future shape is a scheduled board ping, not a spawned process. It is reachable and typed, but not built in v0.3.1.
- **Single implicit tenant today.** Every ledger row carries a `tenant_id` column, but it is a dormant seam; no per-tenant filtering is active. Multi-tenant scoping is a future seam, not a shipped feature.

<Note>
These docs describe Clawboo **v0.3.1**, the current release.
</Note>

## See also

- [Routines](/using/routines): the view that creates, opens, and edits Routines
- [The board](/concepts/the-board): the durable task substrate an agent fire materializes into
- [Delegation and orchestration](/concepts/delegation-and-orchestration): how a lead turns a team fire's message into board tasks
- [Governance](/concepts/governance): the budgets and caps a scheduled fire runs under
- [Observability](/concepts/observability): the `routine_*` events a fire emits
- [Gateway and events](/concepts/gateway-and-events): the OpenClaw operator connection the connected dispatch rides
- [Recurring team work guide](/guides/recurring-team-work): a how-to for scheduling recurring work
- [Schedules API](/reference/rest-api/schedules): the REST surface over the unified scheduler
- [Glossary](/appendices/glossary): canonical term definitions
