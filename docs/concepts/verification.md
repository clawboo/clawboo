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

Clawboo can check an agent's work before the task counts as done. It runs the project's test command, and for bigger, risky or handed-down changes a second agent reviews the change. The check runs in two cases: a task-runner run that worked in its own git worktree and changed files, and a team-chat task that changed its team's folder on a team with a [work check](/using/teams#work-check). Other work is never checked.

## When checks run

### Task-runner runs

A task-runner run is checked when all three of these are true:

1. **The task ran on the task runner.** That means an agent Routine whose task names a repository (set through the API), or a run started with `POST /api/runtimes/:id/run` and a `repoPath`. [How a team works](/intro/how-it-works) explains the two paths. A worktree completed through the board's workspace API is also checked, without a reviewer.
2. **The task changes files**, so it got its own git worktree. Research and review tasks get none.
3. **The agent changed something.** A run that changed no files lands in **Done** without a check.

A Routine you create in the app sends only its instructions, so it runs without a repository, and its work is not checked this way.

### Team chat

A task that runs in team chat is checked when all three of these are true:

1. **The team has a work check.** That is the verify command you set in the team's settings (see [Teams](/using/teams#work-check)). Without one, team-chat work is not checked: a lot of it writes documents rather than code, and a check with no command can only fail.
2. **The agent works in the team folder.** Claude Code, Codex, Hermes and Clawboo Native runs start in `~/.clawboo/workspaces/<team id>`. OpenClaw agents work in their Gateway's workspace and are not checked.
3. **The run changed the team folder**, compared with the folder as it was when the task first started. A run that changed nothing, with no failed attempt before it, lands in **Done** without a check.

This covers work handed off in General or a room, the steps of a plan, and tasks you give an agent on the Board that run through the team, including their reruns from **Retry** or **Assign**.

### Never checked

- Team-chat work on a team with no work check, or by an OpenClaw agent
- One-to-one chats
- OpenClaw work. An OpenClaw Routine run gets a comment saying it completed without verification.
- Agent Routines created in the app (a team Routine posts into team chat, where the rules above apply)
- Research and review tasks on the task runner
- Tasks you move to **Done** yourself

A task with no check result reaches **Done** normally. Unchecked is not the same as failed.

## What happens during a check

1. The agent's run ends. On the [Board](/using/board) the card stays in **In progress** with a **Verifying** badge.
2. Clawboo runs the team's verify command if the team has one, otherwise the one named in the worktree's `init.sh`, inside the worktree, and reads its exit code. A team-chat task's check runs the team's command in the team folder. The command gets 10 minutes. Time the computer spends asleep does not count, except a sleep of under about a minute.
3. If the command passes and the change is large, risky or handed down from another task, a reviewer agent reads the committed change.
4. Clawboo stores the result on the task and moves the card to match. In team chat, whoever handed out the task hears about it only after the check: on a pass, as a normal result.

```mermaid
flowchart TD
    A["Agent finishes"] --> B{"Changed files?"}
    B -->|No| D["Done, unchecked"]
    B -->|Yes| C["Run the verify command"]
    C -->|Fails| F["Fail"]
    C -->|Passes| R{"Large, risky or handed down?"}
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

- The task was handed down from another task (it has a parent task). In team chat, a hand-off straight from the lead, or a task you give on the Board, has no parent task; one a teammate hands off while working on its own task does.
- More than 5 files changed.
- More than 300 lines changed, counting lines added and removed.
- The task's title or description names a risky action: delete, destroy, drop table, deploy, publish, release, `rm -rf`, prod or production, secret, credential, API key or force push. It is the same word list team chat uses to ask a leader before a risky hand-off.

These rules are fixed. A small change on a task with no parent task, whose title and description name none of those words, is judged by the test command alone.

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

| Failure                                   | What Clawboo does                                                           | What you see                                                       | What you can do                                                |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| The agent says it is done, but tests fail | Runs the verify command itself and trusts only its exit code                | The task goes back for a fix, then to **Needs you**                | Read the failure comment on the card                           |
| The agent marks its own work              | A reviewer in a fresh session reads large, risky or handed-down changes     | Blocking findings send the work back                               | Set `CLAWBOO_REVIEWER_MODEL` for a different model             |
| No test command is set                    | A task-runner check fails on the placeholder; team-chat work is not checked | A task-runner task reaches **Needs review** after the last attempt | Set the team's verify command, or name the command in the task |
| A fix loop that never ends                | Two attempts by default, then stop                                          | The card waits in **Needs you**                                    | Retry, complete it anyway, or dismiss it                       |
| A check that hangs                        | Stops the command after 10 minutes, with everything it started              | Counts as a failure                                                | Make the command finish faster                                 |

## Checks in team chat

A team-chat task has no worktree: every teammate works in the same team folder. To see what a task changed, Clawboo keeps a history of the folder outside it, in `~/.clawboo/team-folder-history/<team id>.git`, and saves the folder there when the task first starts and again each time a run of it ends well. A later run (a fix round, or a **Retry**) keeps that first starting point. A run that fails or is stopped saves nothing: its changes are seen by the task's next checked run, and a cancelled task's are never checked. The folder itself never becomes a git checkout, and no `VERIFICATION.md` is written into it; the result is stored on the task.

- **A fix round** gets the note of what failed together with the task itself, because a team-chat run starts a fresh session. Its check compares the folder with how it was when the task first started, so it covers all of the task's work.
- **The reviewer** reads a separate checkout of the folder as the run left it, made from that history.
- **Whoever handed out the task** hears about it once, after the check. When the last attempt fails, they are told the task failed the team's check and needs a person.
- **While a task is checked**, its agent takes no other task, and a reply the agent gives you in that time is not taken as the task's result.

What a team-chat check cannot see:

- **Teammates working at the same time.** The command runs on the live folder, so it also sees what a teammate changes while the check runs, and a task's change includes anything a teammate changed in the folder while the task ran.
- **Files outside the team folder.** Claude Code, Codex and Hermes can change any file your user account can; only the team folder is compared.
- **Dependency folders.** `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo` and `target` are not counted as changes.
- **Uncommitted edits inside a git repository** an agent cloned into the team folder. Only a new commit there counts as a change.
- **Files a `.gitignore` in the team folder ignores.** They are not counted as changes, so a run that changed only those is not checked. They stay out on purpose: they include files such as `.env`, which would otherwise land in the history and the reviewer's checkout.

When a team-chat check cannot finish, the task waits in **Needs you** with a comment, and whoever handed it out is told:

- **Clawboo restarts, or the chat is closed,** while the check runs. The task moves once Clawboo is running again.
- **The check does not answer within 30 minutes.** The verify command itself is stopped after 10.
- **The check cannot run**, for example because the folder's history is missing, or a fix round can no longer be checked after an earlier attempt failed.
- **A fix round cannot be started**, for example because the board could not record its run. The comment says why.

If Clawboo cannot record the team folder when a task starts, the task is not checked, and a comment on it says so. Pressing **Stop** during a check lets it finish: a pass still lands in **Done**, and a failure starts no fix round. If a person moves the card while its check runs, the check's result is dropped and the card stays where they put it. If the check passes but the board does not take the task to **Done**, it waits in **Needs you** too, with a comment that says so. After a person's **Retry** of a task that failed its check, the task is measured again from where it first began, so a retry that changes nothing is still checked. Deleting a team deletes its folder's history too.

## Limits

- Only task-runner runs in a worktree, and team-chat tasks on a team with a work check, are checked. The dashboard cannot start a task-runner run.
- A check is only as strong as its command, and without a team verify command the agent can edit `init.sh`.
- The team's verify command can be changed by any local caller of the API, an agent's shell included. It keeps a cooperative agent from choosing its own check; it does not stop one that sets out to.
- The reviewer runs on the agent's own runtime, with the agent's model unless you set `CLAWBOO_REVIEWER_MODEL`.
- Task-runner work stays on its own branch, `clawboo/task-<id>`. Clawboo never merges it; merging is up to you. Team-chat work stays in the team folder, where the agent made it.
- A check is not continuous integration: it runs one command, once per attempt, with no pipeline, cache or test matrix.

<Accordion title="Under the hood">

- **Where it runs.** `verifyTask` (`apps/web/server/lib/verification/index.ts`) is called from `actOnTaskWorkspace` (`apps/web/server/lib/worktrees.ts`) and from the team chat's work check (`apps/web/server/lib/teamChat/teamWorkCheck.ts`). The task runner calls `actOnTaskWorkspace` with a reviewer when a run completes (`apps/web/server/lib/executorRunner.ts`). `PATCH /api/board/:taskId/workspace` with `{"action": "complete"}` calls it without one, so that route never runs the reviewer.
- **Team chat.** The team engine's `workCheck` dependency (`@clawboo/team-orchestration`) calls `begin` before it delivers a fresh run of a task, which commits the team folder to a bare repository outside it and pins `refs/clawboo/base/<task id>`, and `prepare` when the run ends well. A changed folder moves the task to `in_review` and runs `verifyTask` there with the team's command, the commit as the reviewed revision, and no `VERIFICATION.md`. Its `shouldRecord` drops the verdict once the task has left `in_review` or a newer execution of it has started. A pass lets the engine mark the task done; a failure with an attempt left moves it back to `in_progress` and the engine delivers a fix round as a new execution; the last failure moves it to `blocked` and the delegator's `[Task Update]` has the outcome `check_failed`. The base ref stays until a pass, or a person's Done or Cancelled, so a Retry is measured from the task's first start. A task left `in_review` with an open engine execution and no check under way is blocked by the next engine's `resume()` (outcome `check_interrupted`), and the dispatch pump builds the engine of any room holding one (`listRoomsWithEngineTasksInReview`).
- **The command.** The team's verify command (settings key `team-verify-command:<teamId>`) wins and is recorded as `commandSource: 'configured'`. Otherwise the gate reads `VERIFY_CMD='...'` from `init.sh`, then the `- Verify:` line of `VERIFICATION.md`, and records `scaffold` when that command matches the `init.sh` of the task's scaffold commit (read from the repository with `git --no-replace-objects`), else `agent`. A command containing `configure VERIFY_CMD` counts as none (`packages/governance/src/verify/commandParser.ts`). It runs through a shell in the worktree with Clawboo's secrets removed from its environment, keeps the last 4,000 characters of output, and refuses a worktree outside the Clawboo folder and the work folder's `worktrees/` and `reviews/`, or one whose real path, links resolved, leaves them; it runs in that real path (`apps/web/server/lib/verification/deterministicGate.ts`; see [The work folder](/operating/data-and-state#the-work-folder)).
- **The stored result.** Statuses are `pass`, `fail` and `completed_with_debt`, which is given at the last attempt. A `completed_with_debt` result lists the open issues in `debtNotes`, and a later pass with debt adds to them. A later check whose command passes drops the failed command's issue, even when the reviewer then fails the work. A `fail` keeps the rest, and the task drawer lists them under the failure, marked **Still open from an earlier pass with debt**. A `pass` clears them all when its review completed. A pass with no review, or with a review that returned nothing or did not complete, keeps the reviewer's issues, because nobody looked at them again. The task drawer lists those under **Passed**, marked **Not reviewed again**. Each attempt's own result stays in `attempts`. `PATCH /api/board/:taskId` refuses `done` with `409 verification_required` while a stored result blocks it, unless the request sets `humanOverride`, which writes a `verification` audit row. A stored result that cannot be parsed does not block, and `completed_with_debt` over a passing command does not block a later move to Done.
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
