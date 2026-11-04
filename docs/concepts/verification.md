---
title: 'How work is checked'
sidebarTitle: 'How work is checked'
description: 'When Clawboo runs a test command and a reviewer on finished work, what each outcome means on the Board, and what is never checked.'
icon: 'list-checks'
keywords:
  [
    'verification',
    'verify',
    'VERIFY_CMD',
    'init.sh',
    'critic',
    'reviewer',
    'builder judge',
    'completed_with_debt',
    'Needs review',
    'Verifying',
    'Complete anyway',
  ]
---

Clawboo can check an agent's work before the task counts as done. It runs the project's test command, and for bigger or handed-off changes a second agent reviews the change. These checks run in one narrow case: a task-runner run that worked in its own git worktree and changed files. Most work, including everything handed off in team chat, is never checked.

## When checks run

Checks run only when all three of these are true:

1. **The task ran on the task runner.** That means an agent Routine whose task names a repository (set through the API), or a run started with `POST /api/runtimes/:id/run` and a `repoPath`. [How a team works](/intro/how-it-works) explains the two paths. A worktree completed through the board's workspace API is also checked, without a reviewer.
2. **The task changes files**, so it got its own git worktree. Research and review tasks get none.
3. **The agent changed something.** A run that changed no files lands in **Done** without a check.

Nothing in the dashboard starts a checked run. A Routine you create in the app sends only its instructions, so it runs without a repository, and its work is not checked.

### Never checked

- Work handed off in team chat, in General or a room, including the steps of a plan
- Tasks you give an agent on the Board, and their reruns from **Retry** or **Assign**
- One-to-one chats
- OpenClaw work. An OpenClaw Routine run gets a comment saying it completed without verification.
- Routines created in the app
- Research and review tasks
- Tasks you move to **Done** yourself

A task with no check result reaches **Done** normally. Unchecked is not the same as failed.

## What happens during a check

1. The agent's run ends. On the [Board](/using/board) the card stays in **In progress** with a **Verifying** badge.
2. Clawboo runs the team's verify command if the team has one, otherwise the one named in the worktree's `init.sh`, inside the worktree, and reads its exit code. The command gets 10 minutes. Time the computer spends asleep does not count, except a sleep of under about a minute.
3. If the command passes and the change is large or was handed off, a reviewer agent reads the committed change.
4. Clawboo stores the result on the task and moves the card to match.

```mermaid
flowchart TD
    A["Agent finishes"] --> B{"Changed files?"}
    B -->|No| D["Done, unchecked"]
    B -->|Yes| C["Run the verify command"]
    C -->|Fails| F["Fail"]
    C -->|Passes| R{"Large or handed off?"}
    R -->|No| P["Pass: Done"]
    R -->|Yes| V["Reviewer reads the change"]
    V -->|Blocking issue| F
    V -->|Nothing blocking| P
    F --> L{"Attempt left?"}
    L -->|"Yes: fix note"| A
    L -->|No| N["Needs you"]
```

## The three outcomes

| Outcome                   | When                                                                    | What you see                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Pass**                  | The command passed, and the reviewer, if it ran, found nothing blocking | The card moves to **Done**                                                                                           |
| **Fail, attempt left**    | The command failed, or the reviewer found a blocking issue              | The task goes back to the agent with a note: what failed, why, and how to fix it. The agent tries again              |
| **Fail, no attempt left** | The last attempt failed too. By default that is the second attempt      | The card moves to **Needs you** with a comment, and whoever handed out the task (or the team's leader) gets a notice |

In **Needs you**, the card reads **Needs review** while the test command still fails. When only reviewer findings are left, it reads **Blocked**.

Each task gets two attempts by default: the first, plus one fix round. The `CLAWBOO_MAX_FIX_CYCLES` environment variable sets the number of fix rounds; `0` means a single attempt.

## The verify command in practice

Clawboo knows your project's test command only if you set it for the team: under **Work check** in the team's settings (see [Teams](/using/teams#work-check)), or with `PUT /api/team-verify-command/:teamId` and `{"command": "npm test"}` (see the [Teams API](/reference/rest-api/teams)). When the team has one, every check runs it, whatever `init.sh` says, and each new worktree's `init.sh` starts with it.

Without one, each new worktree gets an `init.sh` whose verify line is a placeholder:

```bash
VERIFY_CMD='echo "[init] configure VERIFY_CMD in init.sh"'
```

A placeholder counts as no command, and no command counts as a failure, because a check cannot pass work it never tested. So the agent is told before it starts: the run's instructions and the worktree's `TASK.md` say to set `VERIFY_CMD` in `init.sh` to the command that proves the work. If it does, and that command passes, the first check can pass. If it does not, the first check fails and the fix note tells it again; a task whose agent never sets a command ends in **Needs you**.

<Tip>

To get a useful check, say in the task which command proves the work, for example: "Before you finish, set `VERIFY_CMD` in `init.sh` to `npm test`."

</Tip>

The agent that did the work can edit `init.sh`, so without a team verify command it can also weaken its own check. Each check therefore records where its command came from, and the task drawer shows the command with its source: **set for the team**, **from the task setup** (the `init.sh` Clawboo wrote, unchanged), or **written by the agent**, which is flagged. Only **set for the team** is a guarantee: an agent can also write a commit that looks like the setup's, so **from the task setup** means no edit was found, not that none was made. The reviewer is the independent part.

## When the reviewer runs

The reviewer runs only after the test command passes, and only when at least one of these holds:

- The task was handed out by another agent (it has a parent task).
- More than 5 files changed.
- More than 300 lines changed, counting lines added and removed.
- The task's title or description names a risky action: delete, destroy, drop table, deploy, publish, release, `rm -rf`, prod or production, secret, credential, API key or force push. It is the same word list team chat uses to ask a leader before a risky hand-off.

These rules are fixed. A small change on a task nobody handed out, whose title and description name none of those words, is judged by the test command alone.

How the reviewer works:

- **It is a second run of the same runtime.** It starts a fresh session, on a separate checkout of the committed change that has no branch to push. It gets none of the first agent's session or runtime home.
- **It uses the same model** unless you set `CLAWBOO_REVIEWER_MODEL`, which picks a different model on that runtime.
- **Only five kinds of finding block:** security, crash, data loss, wrong algorithm, and missing acceptance criteria. Style, performance and other notes are recorded and never block.
- **It cannot hold the work back by failing.** If the reviewer fails to run, the test command alone decides. A reply Clawboo cannot read becomes one note that does not block. The task drawer names the reviewer only when it returned a verdict; otherwise it says **Review did not complete** or **Review returned nothing**.
- **Its spend counts.** The reviewer's run is charged to the same agent, mission and team budgets as the work it reviews, and shows in **Tokens Used** under that agent. A review that reports no cost is charged an estimate. It is not added to the run cost on the task's card, and because it runs after the work has finished, a cap it crosses stops the next run, not this one.

## What you can do

- **Move a card while it is being checked.** If you move it to **Done** or **Cancelled**, your move wins. Clawboo keeps the check's result on the task but moves nothing.
- **Accept the work anyway.** While the card is still in **In progress** with **Verifying**, move it to **Done**: if the stored result is a failure, the board asks you to confirm with **Complete anyway**, and Clawboo records the override in the audit log. Once the card is in **Needs you**, the dashboard cannot move it to **Done**; through the API, move the task to `in_progress` and then to `done` with `humanOverride` (see the [Board API](/reference/rest-api/board)).
- **Run it again.** **Retry**, or another agent picked from the card's **More** menu, sends the task back to **To do** and clears its check result. A task the task runner ran goes back through the runner, with the repository and kind it ran with, and its model when the agent is on the same runtime. It gets a worktree when the task names a repository, and is checked again. That needs an agent the runner can run, not one on OpenClaw. Other tasks, and tasks the runner ran before Clawboo started saving these settings, rerun through the team, with no worktree and no check.
- **Drop it.** **Dismiss** moves the task to **Cancelled**.

## The failures checks are for

| Failure                                   | What Clawboo does                                               | What you see                                        | What you can do                                                |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| The agent says it is done, but tests fail | Runs the verify command itself and trusts only its exit code    | The task goes back for a fix, then to **Needs you** | Read the failure comment on the card                           |
| The agent marks its own work              | A reviewer in a fresh session reads large or handed-off changes | Blocking findings send the work back                | Set `CLAWBOO_REVIEWER_MODEL` for a different model             |
| No test command is set                    | The placeholder counts as a failure                             | **Needs review** after the last attempt             | Set the team's verify command, or name the command in the task |
| A fix loop that never ends                | Two attempts by default, then stop                              | The card waits in **Needs you**                     | Retry, complete it anyway, or dismiss it                       |
| A check that hangs                        | Stops the command after 10 minutes, with everything it started  | Counts as a failure                                 | Make the command finish faster                                 |

## Limits

- Only task-runner runs in a worktree are checked, and the dashboard cannot start one.
- A check is only as strong as its command, and without a team verify command the agent can edit `init.sh`.
- The team's verify command can be changed by any local caller of the API, an agent's shell included. It keeps a cooperative agent from choosing its own check; it does not stop one that sets out to.
- The reviewer runs on the agent's own runtime, with the agent's model unless you set `CLAWBOO_REVIEWER_MODEL`.
- Checked work stays on its own branch, `clawboo/task-<id>`. Clawboo never merges it; merging is up to you.
- A check is not continuous integration: it runs one command, once per attempt, with no pipeline, cache or test matrix.

<Accordion title="Under the hood">

- **Where it runs.** `verifyTask` (`apps/web/server/lib/verification/index.ts`) is called only from `actOnTaskWorkspace` (`apps/web/server/lib/worktrees.ts`). The task runner calls it with a reviewer when a run completes (`apps/web/server/lib/executorRunner.ts`). `PATCH /api/board/:taskId/workspace` with `{"action": "complete"}` calls it without one, so that route never runs the reviewer.
- **The command.** The team's verify command (settings key `team-verify-command:<teamId>`) wins and is recorded as `commandSource: 'configured'`. Otherwise the gate reads `VERIFY_CMD='...'` from `init.sh`, then the `- Verify:` line of `VERIFICATION.md`, and records `scaffold` when that command matches the `init.sh` of the task's scaffold commit (read from the repository with `git --no-replace-objects`), else `agent`. A command containing `configure VERIFY_CMD` counts as none (`packages/governance/src/verify/commandParser.ts`). It runs through a shell in the worktree with Clawboo's secrets removed from its environment, keeps the last 4,000 characters of output, and refuses a worktree outside the Clawboo folder and the work folder's `worktrees/` and `reviews/` (`apps/web/server/lib/verification/deterministicGate.ts`; see [The work folder](/operating/data-and-state#the-work-folder)).
- **The stored result.** Statuses are `pass`, `fail` and `completed_with_debt`, which is given at the last attempt. A `completed_with_debt` result lists the open issues in `debtNotes`, and a later pass with debt adds to them. A `fail` keeps the ones already listed, and the task drawer lists them under the failure, marked **Still open from an earlier pass with debt**; the failed command's issue shows there only while the latest command still fails. A `pass` clears them when its review completed. A pass with no review, or with a review that returned nothing or did not complete, drops only the failed command's issue and keeps the reviewer's, because nobody looked at them again. The task drawer lists those under **Passed**, marked **Not reviewed again**. Each attempt's own result stays in `attempts`. `PATCH /api/board/:taskId` refuses `done` with `409 verification_required` while a stored result blocks it, unless the request sets `humanOverride`, which writes a `verification` audit row. A stored result that cannot be parsed does not block, and `completed_with_debt` over a passing command does not block a later move to Done.
- **Skipped by Clawboo.** A run that changed nothing, and an OpenClaw Routine completion (an `unverified` audit row), both reach `done` without the gate.
- **The reviewer trigger.** `shouldRunCritic` in `packages/governance/src/verify/criticTrigger.ts`. Its `riskFlag` comes from `isRiskyDelegation` (`apps/web/server/lib/teamChat/riskyDelegation.ts`) run on the task's title and description, in `verifyTask`.
- **Clearing.** Any move to `todo` clears the stored result.

See [Executor runner](/internals/executor-runner) and the [Board API](/reference/rest-api/board).

</Accordion>

## Related

- [How a team works](/intro/how-it-works): which work runs on the task runner.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): the checkout a check runs in.
- [Board](/using/board): Needs you, Retry and Dismiss.
- [What agents can do](/concepts/permissions): why a worktree is not a sandbox.
- [Environment variables](/reference/environment-variables): `CLAWBOO_MAX_FIX_CYCLES` and `CLAWBOO_REVIEWER_MODEL`.
