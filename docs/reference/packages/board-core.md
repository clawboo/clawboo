---
title: '@clawboo/board-core'
description: 'The pure task rules: the seven board statuses, the legal-transition table, the dispatch rules, and the needs-you classification every layer shares.'
---

- **Version** `0.1.0`
- **Purity** pure zero-dep (browser-safe; no workspace or external deps, no `node:*`, no I/O)
- **Purpose** Declare the seven task statuses and the legal-transition table **once**, so the durable board, the orchestration engine, and the browser board UI all read the same rulebook instead of hand-maintained copies that can silently drift.
- **Workspace deps** none
- **External deps** none

Three layers need these rules and only one of them can touch a database:

- [`@clawboo/db`](/reference/packages/db) re-exports the module and enforces `canTransition` **inside** the write transaction, against the freshly-read row.
- [`@clawboo/team-orchestration`](/reference/packages/team-orchestration) types its `BoardClient` surface with `TaskStatus`.
- The board UI (`apps/web/src/features/board`) derives its columns and its manual status editor from `TASK_STATUSES` + `legalTargets`, so it only ever offers moves the server will accept.

Before this package existed, each of those declared its own copy. They agreed, but nothing linked them: a newly-legal transition on the server would have left the UI hiding a move it now accepts, with green CI. Extracting the rules made drift a compile error rather than something a test has to notice.

<Note>
The module is **import-free**, and that is load-bearing rather than incidental: it is what lets the same file ship into the Vite SPA without dragging the sqlite/server graph along. Two tests pin it — a source guard in this package asserts `state-machine.ts` declares no import at all, and `apps/web/src/__tests__/browserBundlePurity.test.ts` asserts the built artifact declares zero bare specifiers in either module format.
</Note>

The server stays the authority. Any UI or REST-layer pre-check is fast-fail ergonomics; the transactional check in [`updateStatus`](/internals/board-internals) is the real gate, and an illegal transition surfaces as a `409`.

## Public API

### Functions

| Signature                                                  | Contract                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canTransition(from: TaskStatus, to: TaskStatus): boolean` | Whether the move is legal. Same-status returns `true` (an idempotent no-op, so re-emitting a transition is harmless).                                                                      |
| `legalTargets(from: TaskStatus): TaskStatus[]`             | Every status `from` can legally move to, in table order. Excludes the same-status no-op; empty for a terminal status. Returns a fresh array, so a caller cannot mutate the internal table. |
| `isLocked(status: TaskStatus): boolean`                    | `true` for `in_progress` / `in_review` — a locked task is actively owned and must not have its assignee reassigned.                                                                        |
| `isTerminal(status: TaskStatus): boolean`                  | `true` for `done` / `cancelled`. Equivalent to "has no legal targets", and a test pins the equivalence.                                                                                    |
| `isTaskStatus(value: unknown): value is TaskStatus`        | Type guard for untyped input (an API response, a drop target, a CLI argument).                                                                                                             |

### Types & constants

| Name            | Shape / contract                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskStatus`    | `'backlog' \| 'todo' \| 'in_progress' \| 'in_review' \| 'blocked' \| 'done' \| 'cancelled'`.                                           |
| `TASK_STATUSES` | `readonly TaskStatus[]` — the seven statuses in **lifecycle order**, which is also the board's column order and the status dropdown's. |

## The transition table

`done` and `cancelled` are terminal. `in_progress → todo` is the "release" path orphan reconciliation uses.

| From          | Legal targets                                       |
| ------------- | --------------------------------------------------- |
| `backlog`     | `todo`, `blocked`, `cancelled`                      |
| `todo`        | `in_progress`, `blocked`, `backlog`, `cancelled`    |
| `in_progress` | `in_review`, `done`, `blocked`, `todo`, `cancelled` |
| `in_review`   | `done`, `in_progress`, `blocked`, `cancelled`       |
| `blocked`     | `todo`, `in_progress`, `backlog`, `cancelled`       |
| `done`        | — (terminal)                                        |
| `cancelled`   | — (terminal)                                        |

## Dispatch rules

Whether a `todo` task will ever be picked up on its own, from two durable facts the board already stores. The engine's ready-pump (`@clawboo/team-orchestration`) and the server's pump scan (`@clawboo/db` `isLedgerAutoFireable`) both call these, so they cannot disagree about what will run.

| Name                                       | Contract                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_AUTO_FIRES`                           | `3`. The ready-pump re-fires a released task until this many consecutive unsuccessful runs sit at the end of its ledger.                                                                                                |
| `ledgerAllowsAutoFire(execs): boolean`     | The fire policy over a ledger (oldest run first): fire an empty ledger; leave a `running` last run alone; never re-fire a `cancelled` last run (a user Stop); park at `MAX_AUTO_FIRES` trailing failures; else re-fire. |
| `trailingFailedRuns(execs): number`        | How many runs at the end of the ledger ended neither `succeeded` nor `cancelled`.                                                                                                                                       |
| `delegationTargetOf(sdid): string \| null` | The agent a task is bound to: the `:agent:<id>` segment of its `sourceDelegationId`.                                                                                                                                    |
| `isHumanAssignment(sdid): boolean`         | Whether a person (not an agent) bound the task to its agent. A person-assigned task reports its result on its card, not to the team lead.                                                                               |
| `encodeHumanAssignment(agentId, nonce)`    | The `sourceDelegationId` for a task a person assigned: an `:agent:` segment, an `:origin:human` marker, and deliberately no `:reflectTo:`.                                                                              |

## Needs-you classification

`taskAttention({ status, sourceDelegationId, execs, verificationBlocked }): TaskAttention | null` says why a task is waiting on a person, or `null` when the board will move it on its own. The server attaches the result to every task it returns (the `attention` field), and the board UI routes every task that has one into its **Needs you** column.

| Status    | Result                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked` | Always one: `needs_review` when the verdict blocks, else `timed_out` or `failed` from the last run (with that run's error as `detail`), else `blocked`.              |
| `todo`    | `unassigned` with no bound agent; `stopped` when the last run was cancelled; `failed` / `timed_out` once parked at `MAX_AUTO_FIRES`; otherwise `null` (queued work). |
| any other | `null`.                                                                                                                                                              |

`TaskAttention` is `{ reason, failedRuns, detail? }`, where `reason` is an `AttentionReason`.

## Source

`packages/board-core/src/state-machine.ts`, `dispatch.ts` and `attention.ts`, plus a barrel. See [Board internals](/internals/board-internals) for how the repository enforces the transitions and [The board](/concepts/the-board) for the concepts.
