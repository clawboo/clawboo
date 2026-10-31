---
title: '@clawboo/board-core'
sidebarTitle: 'board-core'
description: "The task rules every layer shares: the seven statuses and their legal moves, the auto-fire policy, the Needs you reasons, and a task's run cost."
keywords:
  [
    '@clawboo/board-core',
    'board-core',
    'task statuses',
    'transition table',
    'canTransition',
    'legalTargets',
    'Needs you',
    'taskAttention',
    'MAX_AUTO_FIRES',
    'summarizeRunCost',
  ]
---

`@clawboo/board-core` declares the board's rules once: which statuses a task can have, which moves between them are
legal, when the board fires a task again on its own, why a task is waiting for a person, and what its runs cost.
Every layer imports this one copy, so a newly legal move reaches the server, the team engine and the board view
together, and a mismatch is a compile error.

Use this page when you change a task rule. How the database enforces the rules is on
[Board internals](/internals/board-internals), and the board as users see it is on [The board](/concepts/the-board).

## Who uses it

- **`@clawboo/db`** enforces the transition table inside `updateStatus` and wraps the other rules for whole boards
  (`attentionForTasks`, `runCostForTasks`, `isLedgerAutoFireable`).
- **`@clawboo/team-orchestration`** uses the fire policy and the person-assignment markers when it dispatches work.
- **The server** attaches `attention` and `runCost` to every task the board API returns.
- **The SPA** builds the status editor from `legalTargets`, routes tasks into the **Needs you** column, and shows
  run cost on cards.

The package has no dependencies at all and imports nothing outside its own files, so it can ship to the browser.
`apps/web/src/__tests__/browserBundlePurity.test.ts` checks that the built files declare no bare import and that
`state-machine.ts` imports nothing; the package's own tsconfig pins `types: []`, so a Node global fails the
type check.

## Statuses and legal moves

`TASK_STATUSES` lists the seven statuses in lifecycle order. `done` and `cancelled` are terminal.

| From          | Legal targets                                       |
| ------------- | --------------------------------------------------- |
| `backlog`     | `todo`, `blocked`, `cancelled`                      |
| `todo`        | `in_progress`, `blocked`, `backlog`, `cancelled`    |
| `in_progress` | `in_review`, `done`, `blocked`, `todo`, `cancelled` |
| `in_review`   | `done`, `in_progress`, `blocked`, `cancelled`       |
| `blocked`     | `todo`, `in_progress`, `backlog`, `cancelled`       |
| `done`        | none                                                |
| `cancelled`   | none                                                |

- `canTransition(from, to)` answers one move; a move to the same status is a harmless no-op and returns `true`.
- `legalTargets(from)` returns the targets in table order as a fresh array, empty for a terminal status.
- `isLocked(status)` is `true` for `in_progress` and `in_review`: a task someone is working on keeps its assignee.
- `isTerminal(status)` is `true` for `done` and `cancelled`.

The server is the authority: `updateStatus` re-checks the table against the freshly read row, and an illegal move
through the board API returns `409`. The one writer outside the table is the orphan reaper (`reconcileOrphans`),
which releases a stale `in_progress` or `in_review` task straight to `todo`.

The board view shows **Needs you** and then five status columns (**Backlog**, **To do**, **In progress**,
**Done**, **Cancelled**). An `in_review` task sits in **In progress** under a **Verifying** badge, and every
`blocked` task appears in **Needs you**.

## When a task fires again on its own

`ledgerAllowsAutoFire(execs)` reads a task's run ledger, oldest run first, and decides whether the ready-pump may
start it again. The team engine's pump and the server's scan both call it, so they agree on what will run.

| The ledger                                             | Result                      |
| ------------------------------------------------------ | --------------------------- |
| empty (never delivered)                                | fire                        |
| last run still `running`                               | leave it, someone owns it   |
| last run `cancelled` (a person pressed Stop)           | never fire again on its own |
| `MAX_AUTO_FIRES` unsuccessful runs in a row at the end | park it for a person        |
| anything else (timed out, failed, orphaned)            | fire again                  |

`trailingFailedRuns` counts the runs at the end of the ledger that ended neither `succeeded` nor `cancelled`. A
task's `sourceDelegationId` records who it is bound to: `delegationTargetOf` reads the agent out of it, and
`encodeHumanAssignment` writes the marker for a task a person assigned, which `isHumanAssignment` detects. A
person-assigned task reports its result on its card instead of to the team's leader.

## Why a task needs a person

`taskAttention` returns the reason a task waits on a person, or `null` when the board will move it on its own. The
board view puts every task with a reason in **Needs you**.

| Status        | Reason                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `blocked`     | always one: `needs_review` when the verdict blocks, else `timed_out` or `failed` from the last run, else `blocked` |
| `todo`        | `unassigned` with no bound agent, `stopped` when the last run was cancelled, `failed` or `timed_out` once parked   |
| `in_progress` | `unstarted` when no agent is assigned and nothing is running (a card moved there by hand starts nothing)           |
| any other     | none                                                                                                               |

The result carries the reason, the number of trailing failed runs, and a `detail` taken from the last run's error
(trimmed to a short excerpt).

## Run cost

`summarizeRunCost(runs, taskCostUsd)` adds up what a task's runs cost, for the card and the drawer:

- A run counts only when its `costUsd` is a finite number, so a run stopped before it priced itself adds nothing.
- The total is marked as an estimate unless every counted run's `costSource` is `reported`; a missing or unknown
  source counts as an estimate.
- With no counted run, a positive cost stored on the task row itself is returned as an estimate; otherwise the
  cost is `null`.

`RUN_COST_SOURCES` lists `reported`, `token-estimate` and `char-estimate`, most trustworthy first.

## Test it

Run `pnpm --filter @clawboo/board-core test`, and `pnpm --filter @clawboo/board-core typecheck`, which checks the
source and the tests against separate tsconfigs. A rule change usually needs a matching case in the board tests of
`@clawboo/db` and in the cascade contract of [@clawboo/team-orchestration](/reference/packages/team-orchestration).

## Related

- [Board internals](/internals/board-internals): how the database enforces these rules, claims and reconciles.
- [The board](/concepts/the-board): statuses and columns as users see them.
- [Track work on the board](/using/board): working the board day to day.
- [@clawboo/db](/reference/packages/db): the repository that applies the rules.
