---
title: 'Worktrees and handoff'
sidebarTitle: 'Worktrees and handoff'
description: 'When a task gets its own git worktree, what Clawboo writes into it, how another runtime picks the work up, and how you get the result back.'
icon: 'git-branch'
keywords:
  [
    'worktree',
    'git worktree',
    'branch',
    'clawboo/task',
    'AGENT_HANDOFF.json',
    'handoff',
    'system of record',
    'cross-runtime',
    'init.sh',
  ]
---

A **worktree** is a second checkout of your git repository, on its own branch, where one task's agent makes its changes. It keeps two tasks that work on the same repository from editing the same files at once. It leaves you a branch to review when the work is done. It also carries a few files that let a different runtime, or a person, pick the task up where it stopped.

Clawboo makes a worktree only in a few cases, and a worktree is not a sandbox. This page covers when a task gets one, what is in it, how a handoff works, and how you get the work back.

## When a task gets a worktree

A task gets a worktree only when the task runner runs it with a repository path:

- an agent routine whose task template names a `repoPath`, which you set through the [Schedules API](/reference/rest-api/schedules);
- a run started with `POST /api/runtimes/:id/run` and a `repoPath`.

You can also create one ahead of time with `POST /api/board/:taskId/workspace`. The task runner uses it when it later runs that task.

Everything else runs without a worktree:

- **Team chat.** Chats, hand-offs and the Board tasks a team works on never get one, on any runtime.
- **Routines made in the dashboard.** The Routines dialog has no repository field, so an agent routine made there runs as a research task, without a worktree.
- **OpenClaw agents.** They work in their own workspace, which the OpenClaw Gateway manages. Clawboo never gives them a worktree.

In the task runner, the task's kind decides too:

| Kind                 | Gets a worktree |
| -------------------- | --------------- |
| `code` (the default) | Yes             |
| `research`, `review` | No              |
| Any other value      | Yes             |

A task-runner run of a kind that needs a worktree, with no repository path, is refused rather than run somewhere else. The task gets the comment `[blocked: no isolation] This task changes files, so it needs an isolated git worktree, but no repository path was provided for it.` and goes back to To do.

<Warning>

**Without a worktree, coding agents start in their team's folder.** In team chat, and in any other run without a worktree, Claude Code, Codex, Hermes and Clawboo Native start in `workspaces/<team id>` inside your Clawboo folder (`~/.clawboo`, or `CLAWBOO_HOME` if you set it). Every member of the team shares it, and a task or an agent with no team uses `workspaces/_no-team`. The folder only sets where Claude Code, Codex and Hermes start: they run with their own approval prompts turned off, so they can read and change any file your user account can, Clawboo's database and saved keys included. See [What agents can do](/concepts/permissions).

</Warning>

## What a worktree is

- **A separate checkout.** It lives in your Clawboo folder, at `worktrees/<hash of the repository path>/<task id>`. Your own checkout and its working files are not touched, though `git worktree list` and `git branch` in your repository show the extra checkout and its branch.
- **Its own branch.** The branch is `clawboo/task-<task id>`, cut from your repository's current `HEAD`. A caller that creates the worktree through the API can name another commit or ref.
- **A starting commit.** Before the agent starts, Clawboo commits five bookkeeping files to the branch, with the message `clawboo: scaffold task <id>`. The agent's changes are measured from that commit, so the bookkeeping never counts as work.

A worktree keeps one task's file changes apart from another's. It does not limit what the agent's process can do: the process runs with your user account's permissions, and it can read files outside the checkout, reach the network and start other programs. [What agents can do](/concepts/permissions) covers what each runtime can reach.

## The files in a worktree

Each file answers a question that a runtime picking the task up cold needs answered from the checkout alone:

| File                 | What it holds                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TASK.md`            | The task's title, id and description, sections for acceptance criteria and known gotchas, and how to work the task |
| `task-progress.md`   | Where things stand: what is done, in progress and blocked                                                          |
| `DECISIONS.json`     | Decisions made along the way, and why                                                                              |
| `init.sh`            | The install, verify and start commands                                                                             |
| `VERIFICATION.md`    | The verify command and the evidence that the work is done; the verification check adds its results here            |
| `AGENT_HANDOFF.json` | Written when a run finishes: what is done, what is broken or unverified, and the next step                         |

Clawboo writes the first five when it creates the worktree. `AGENT_HANDOFF.json` appears when the first run in it finishes successfully.

`init.sh` starts with placeholder commands that only print a reminder to set them. Clawboo does not fill them in: the agent, or you, has to replace them with real ones. Until the verify command is set, the verification check cannot pass the task. See [Verification](/concepts/verification) for when that check runs.

## The cross-runtime handoff

When a task-runner run in a worktree finishes successfully, Clawboo writes `AGENT_HANDOFF.json` from the run's report. It records who handed off and on which runtime, the run's report (as what is done, or as the next step when the run pauses for another runtime), anything broken or unverified, and how to re-enter the work. If an earlier attempt on the task was interrupted, the handoff says so, so that the next runtime checks before it redoes anything with side effects.

The next run on that task, on any runtime, starts from the checkout alone:

1. Clawboo reads `AGENT_HANDOFF.json`, or `task-progress.md` when there is no handoff yet, and adds what is done, what is broken and the next step to the run's prompt.
2. `TASK.md` tells the agent to run `./init.sh` to confirm the starting point, then carry on from the next step.

Picking the work up needs no chat history and no access to the board. That is what lets a task move from one runtime to another, for example from Claude Code to Codex, or to a person.

- A run started through the API with `keepForResume: true` writes the handoff, keeps the worktree, and puts the task back in To do, ready for a different runtime to pick up.
- The handoff also stores the runtime's own session id. It is used only when the next run is on the same runtime, to resume that session. A different runtime works from the handoff alone.
- A person can write a handoff too, with `POST /api/board/:taskId/workspace/handoff`. Its `runtime` field can be `human`.

The [Cross-runtime handoff guide](/guides/cross-runtime-handoff) walks through it step by step.

## Getting the work back

Clawboo never merges. When a run in a worktree finishes, what happens next depends on whether it changed anything besides the bookkeeping files:

- **It changed files.** The worktree and the `clawboo/task-<id>` branch are kept, and the task goes to verification. Review the work and merge it into your own branch yourself.
- **It changed nothing.** The worktree and its branch are removed, and the task lands Done without a verification check.

Changes can still be uncommitted in the worktree folder when a run ends. Clawboo commits them to the branch when the verify command passes on a task-runner run, when a worktree is paused, and before a cleanup removes the folder. To see the work in the app, open the **Workspace** tab on the agent's page, or the **Workspace** section of the task on the Board, which shows the changed files and the diff.

### Cleanup

When the Clawboo server starts, it removes worktree folders that are older than 72 hours, or beyond the newest 25 for a repository. Tasks that are in progress or in review are skipped. Before removing a folder, Clawboo commits any uncommitted work to the branch. The branch itself is kept, so nothing is lost: if the task runs again, Clawboo rebuilds the checkout from the branch.

Branches are never deleted by cleanup. Delete the `clawboo/task-<id>` branches you no longer need with git.

<AccordionGroup>

<Accordion title="Under the hood">

- Clawboo's commits on a task branch use the messages `clawboo: scaffold task <id>`, `clawboo: checkpoint task <id>` (after the verify command passes, before the reviewer), `clawboo: pause task <id>` and `clawboo: gc autosave task <id>`.
- `PATCH /api/board/:taskId/workspace` with `{ "action": "pause" }` commits the work, removes the folder and keeps the branch. `{ "action": "complete" }` runs the empty-or-changed decision above and, for changed work, the verify command without the reviewer. `POST /api/board/:taskId/workspace` refuses a `research` or `review` kind with `422 no_isolation`.
- The reviewer works in a detached checkout at the committed work, under `reviews/<hash>` in your Clawboo folder. The checkout has no branch of its own.
- If `AGENT_HANDOFF.json` cannot be read or parsed, Clawboo treats it as missing and falls back to the `## Done` and `## Blocked` sections of `task-progress.md`.
- Every git call Clawboo makes has a 60-second timeout.
- The lifecycle functions are documented in [@clawboo/worktrees](/reference/packages/worktrees), and the run loop in [Executor runner](/internals/executor-runner).

</Accordion>

</AccordionGroup>

## Related

- [What agents can do](/concepts/permissions): what each runtime can reach, with or without a worktree.
- [Verification](/concepts/verification): when finished work is checked, and what a failing check does.
- [Cross-runtime handoff guide](/guides/cross-runtime-handoff): pause a task on one runtime and resume it on another.
- [How routines run](/concepts/scheduling): why routines made in the dashboard get no worktree.
- [Board API](/reference/rest-api/board): the `/api/board/:taskId/workspace` routes.
