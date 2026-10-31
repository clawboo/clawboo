---
title: '@clawboo/worktrees'
sidebarTitle: 'worktrees'
description: "Per-task git worktrees for the task runner: the lifecycle, the task's working files and handoff record, path safety, cleanup, and the keyed mutex."
keywords:
  [
    '@clawboo/worktrees',
    'worktrees',
    'git worktree',
    'AGENT_HANDOFF.json',
    'TASK.md',
    'init.sh',
    'VERIFY_CMD',
    'gcWorktrees',
    'KeyedMutex',
    'assertSafeTaskId',
    'system-of-record files',
  ]
---

`@clawboo/worktrees` gives a file-changing task its own git worktree and branch, writes the working files any
runtime can resume the task from, and records a structured handoff when a run ends. It is server-only, because it
runs `git` and writes files. The board decides what runs; this package is only the git and file mechanism, and the
database bookkeeping (the task's `workspaces` row) lives in `apps/web/server/lib/worktrees.ts`.

Use this page when you change how task runs are isolated, paused, resumed or cleaned up. The model behind it is on
[Worktrees and handoff](/concepts/worktrees-and-handoff). A worktree keeps parallel teammates' file changes apart,
but it is not a sandbox: see [What agents can do](/concepts/permissions).

## When a task gets a worktree

`isolationForTask(kind)` returns `none` for `research` and `review` tasks and `worktree` for `code` and any unknown
kind; it never returns `container`. Worktrees are made by the task runner (a run of
`POST /api/runtimes/<id>/run`, or an agent routine that names a repository) and by
`POST /api/board/<taskId>/workspace`; team chat never makes one. The task runner refuses a file-changing task with
no repository path (`workspace_unavailable`) rather than run it without isolation; see
[The executor runner](/internals/executor-runner).

The package's default root is `<repo>/.clawboo/worktrees`, but the server always passes its own: task worktrees
live at `<clawboo home>/worktrees/<hash of the repo path>/<task id>` and review checkouts under
`<clawboo home>/reviews/`, so nothing is created inside your repository. Each task gets the branch
`clawboo/task-<task id>`.

## The lifecycle

| Function                  | What it does                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisionWorktree`       | Branches from a commit (never the dirty working tree), writes the working files and commits them as the baseline. It clears leftovers of an earlier attempt, reuses a branch that already exists, checks that git registered the folder, and retries once. |
| `resumeWorktree`          | Re-attaches a paused task's branch at its tip, keeping earlier commits. Throws when the branch is gone.                                                                                                                                                    |
| `loadWorktree`            | Rebuilds the handle for a task that already has a worktree.                                                                                                                                                                                                |
| `pauseWorktree`           | Commits any uncommitted work, removes the worktree folder and keeps the branch.                                                                                                                                                                            |
| `commitWorktreeWork`      | Commits without removing anything; the critic's checkpoint before a review.                                                                                                                                                                                |
| `completeWorktree`        | Diffs against the baseline, ignoring the working files. With no change it removes the worktree and the branch; otherwise the branch stays for a person to merge.                                                                                           |
| `gcWorktrees`             | Reaps worktrees by age and by count (defaults: 72 hours, 25 worktrees), commits before it drops one, skips active tasks, and keeps going past a failure. It touches only the worktree root.                                                                |
| `provisionReviewWorktree` | A detached checkout at one commit for the read-only reviewer, so there is no branch to push. It replaces any earlier checkout at the same path.                                                                                                            |

Clawboo never merges a task branch; finished work waits on `clawboo/task-<task id>`.

## The working files

`SOR_FILES` names the system-of-record files, which any runtime (or a person) reads to pick a task up cold:

| File                 | Holds                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| `TASK.md`            | what and why, acceptance criteria, known gotchas                                 |
| `task-progress.md`   | the running log of what was done                                                 |
| `DECISIONS.json`     | a structured decision log (`clawboo/decisions@1`)                                |
| `init.sh`            | `INSTALL_CMD`, `VERIFY_CMD` and `START_CMD`, as an executable script             |
| `VERIFICATION.md`    | the evidence the verification gate reads and appends to                          |
| `AGENT_HANDOFF.json` | written at the end of a run by `writeHandoff`, validated by `agentHandoffSchema` |

`writeScaffold` writes the first five. `reconstructState(path)` rebuilds what is done, what is broken and what comes
next from the handoff (falling back to `task-progress.md`) and `init.sh`, with no access to chat or the board, which
is what lets a different runtime resume the task. The scaffold's `VERIFY_CMD` is a placeholder: until the agent sets
a real command, the verification gate reports that no verify command is configured and the attempt fails.

## Path safety

These functions remove folders recursively and run commands, so every path they act on is checked first:

- **Task ids are one path segment.** `assertSafeTaskId` accepts only `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and throws
  for anything else rather than rewriting it. `branchNameForTask`, `worktreePathFor` and the lifecycle functions
  all go through it.
- **Task folders stay under the root.** `worktreePathFor(repo, taskId, rootDir)` resolves the task's folder and
  throws if it would land anywhere but one segment below the root.
- **Removal rebuilds the path.** Before their recursive remove, `pauseWorktree` and `completeWorktree` rebuild the
  folder from the root and the task id, and throw if the stored record points somewhere else.
- **Review checkouts are trusted input.** `removeReviewWorktree` removes the path in the record it is given without
  that check, so pass it only a record `provisionReviewWorktree` returned.
- **Verify commands run in Clawboo's folder only.** The server's verification gate refuses a worktree path outside
  Clawboo's state folder before it runs `VERIFY_CMD`.

## Helpers you will reach for

- **`KeyedMutex`.** `mutex.run(key, fn, { acquireTimeoutMs })` serializes work per key and throws
  `MutexAcquireTimeoutError` when the wait runs out. The lifecycle functions lock per worktree path, the task runner
  locks each agent's persistent home (the wait is `CLAWBOO_HOME_MUTEX_ACQUIRE_MS`), and the OpenClaw routine
  dispatcher locks per agent.
- **`execGit(cwd, args)`.** Runs `git` with a timeout and an output cap and throws `GitError` with the command's
  `stderr` and `args`. The Workspace tab's git status and file diffs use it.
- **Diffs.** `diffStat` and `worktreeDiff` compare a worktree with its baseline, and `isDetached` confirms a review
  checkout has no branch.

## Who uses it

Only the server: the task runner, the board's workspace routes, the verification gate and critic, the Routines
dispatchers, and the Workspace tab's file view. Agent chat and team chat import only `MutexAcquireTimeoutError`, to
recognise a busy agent home.

## Test it

Run `pnpm --filter @clawboo/worktrees test`. The suite creates real git repositories in temporary folders, so it
needs `git` on your `PATH`; CI also runs it on Windows and macOS.

## Related

- [Worktrees and handoff](/concepts/worktrees-and-handoff): why tasks get worktrees and how handoff works.
- [Hand a task from one runtime to another](/guides/cross-runtime-handoff): the handoff from start to finish.
- [The executor runner](/internals/executor-runner): when the runner provisions, pauses and completes a worktree.
- [How work is checked](/concepts/verification): how the verify command and the critic judge the work.
