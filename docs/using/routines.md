---
title: Routines
description: 'Schedule recurring work for a team or one agent from the Routines view, then open, edit, pause, run, or delete any routine.'
---

Use this page when you want work to happen on a clock without anyone at the dashboard: a morning briefing, an hourly inbox check, a weekly report. Clawboo calls that a **routine**. Routines run on Clawboo's own scheduler for every runtime, and each routine is one of two kinds:

- **A team task** posts its instructions into a team's group chat, addressed to the team's lead (Boo Zero). The lead reads it the way it reads a message you typed: it answers, or brings in teammates, and everything that follows shows in that chat and on the team's board.
- **An agent task** gives one agent a task on the board. The agent works it through the normal executor path, and its result lands on the task card, which the team chat shows as well.

If you use OpenClaw, the view also lists the OpenClaw Gateway's own cron jobs, in a section of their own.

## Prerequisites

<Note>
Open **Settings** (the gear at the bottom of the sidebar, or `Cmd/Ctrl + ,`) and choose **Routines** under the Workspace group. The view re-reads `GET /api/schedules` every 8 seconds while the window is visible, so statuses and countdowns stay current. **Refresh** reads it at once.
</Note>

- A team task needs a team with at least one member.
- An agent task needs an agent. Agents that are on no team can have routines too.
- A routine for an OpenClaw agent needs the OpenClaw Gateway connected when it runs, because the run rides that connection. Routines for every other runtime have no such requirement.

## The Routines view

The header shows how many routines there are, a **New routine** button, and **Refresh**. Below it, rows are grouped:

| Section                      | What lives here                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| **Team routines**            | Routines that post to a team chat                                                  |
| **Agent routines**           | Routines that give one agent a task                                                |
| **OpenClaw's own cron jobs** | Cron jobs the OpenClaw Gateway runs for its agents. Shown only when there are some |

Each row shows the routine's name and status, where it goes (for example `Research team chat · Boo Zero leads` for a team, or `Ada · Research` for an agent on the Research team), how often it runs, when it runs next, and when it last ran. A routine that stopped after a failed run shows the error in red.

| Pill                            | Meaning                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `on`                            | Armed. It runs at its next time                                      |
| `queued`, `starting`, `running` | A run is on its way or in progress                                   |
| `paused`                        | You paused it. It does not run until you resume it                   |
| `failed`                        | The last run failed. A routine stops until you resume it (see below) |
| `finished`                      | A one-time routine that already ran                                  |
| `disabled`                      | An OpenClaw cron job that is turned off on the Gateway               |

Click a row to open it. The three buttons at the right of a row are shortcuts for **Pause** or **Resume** (**Disable** or **Enable** on an OpenClaw cron job), **Run now**, and **Delete**. OpenClaw cron jobs are created on the Gateway, not here, and have no **Edit**.

<Note>
When the OpenClaw Gateway is disconnected, the list still loads. If you use OpenClaw, an amber notice says its cron jobs are hidden until it reconnects, or that the list shown is the last one the Gateway sent.
</Note>

## Steps

### Create a routine

1. Click **New routine**.
2. Under **Who it is for**, choose **A team task** or **An agent task**.
3. Pick the **Team**. A new routine starts on the team you are looking at. For an agent task, then pick the **Agent** from that team. Agents that are on no team are listed under **No team (standalone agents)**.
4. Under **What should happen**, write the instructions. For a team task this is the message the lead receives. For an agent task it is the task's description.
5. Optionally give it a **Name**. Without one, the routine is named after the first line of its instructions.
6. Pick when it **Runs**: one of the presets, or **Custom** to type a cron expression. The dialog shows when the next run would be.
7. Click **Create routine**.

While **Create routine** is disabled, the footer says what is still missing, such as "Choose an agent." A team with no members shows a warning under the team picker, because nobody would pick the routine up.

### Open a routine

Clicking a row opens the routine:

- **Sends to** names the team chat and who leads it, or the agent and its team. A team routine has **Open team chat**, which takes you straight to that chat. An agent routine names the runtime it runs on.
- **What happens** shows the instructions it sends.
- **Schedule** shows how often it runs and when it runs next.
- **Last run** shows when it last ran.
- **Recent runs** lists the last ten runs, newest first, with how long each took. A team run reads `posted` once the lead has the message. An agent run reads `done` once its task is finished, and **View task** opens that task with the agent's report. A run that never recorded an outcome, because the server stopped during it, reads `interrupted`.

The buttons at the bottom are **Edit**, **Pause** (or **Resume**), **Run now**, and **Delete**.

### Edit a routine

Click **Edit** to change who it is for, the team or agent, the instructions, the name, or the schedule, then **Save changes**. Only the fields you changed are sent. Changing the schedule of a paused or stopped routine does not turn it back on; resume it for that.

### Pause or resume

**Pause** stops a routine from running until you **Resume** it. Resuming arms it again at the next time its schedule gives. A paused routine never runs on its own. While a run is in progress the routine can be neither paused nor resumed; hovering the disabled button says so, and it comes back once the run finishes.

### Run now

**Run now** starts a run straight away without changing the schedule. It returns `202` at once rather than waiting for the run, and the pill moves through `queued` and `running` within a moment. It is available while the routine is on: resume a paused or stopped routine first, and a routine that is already running cannot start a second run.

### Delete

**Delete** asks first, then removes the routine. Tasks and messages it already produced stay where they are.

## Options

### Schedule presets

| Preset           | Cron           |
| ---------------- | -------------- |
| Every 5 minutes  | `*/5 * * * *`  |
| Every 15 minutes | `*/15 * * * *` |
| Every 30 minutes | `*/30 * * * *` |
| Every hour       | `0 * * * *`    |
| Every 6 hours    | `0 */6 * * *`  |
| Every 12 hours   | `0 */12 * * *` |
| Daily · 9am      | `0 9 * * *`    |
| Weekdays · 9am   | `0 9 * * 1-5`  |
| Weekly · Mon 9am | `0 9 * * 1`    |

A new routine starts on **Every hour**. **Custom** takes any cron expression: minute, hour, day of month, month, day of week. For example, `30 8 * * 1-5` is 8:30 on weekdays. Times are in the local time of the machine Clawboo runs on.

### One-time runs (`once@<ISO>`)

A routine's schedule can also be a single run at a future time, written `once@<ISO-8601>` (for example `once@2026-07-01T09:00:00Z`). The dialog only offers recurring schedules, so create a one-time routine through `POST /api/schedules`. After it runs it reads `finished` and never runs again.

### Where an agent task runs

An agent task runs the way the agent works a task delegated in team chat: without a git worktree. A routine created through the API with a `repoPath` works in its own worktree of that repository instead. See [Schedule recurring team work](/guides/recurring-team-work#from-the-api).

## When a run fails

A routine whose run fails **stops**. Its pill reads `failed`, the row shows the error, and it does not run again until you resume it. This is deliberate: a routine that retried a broken run on every tick would spend budget and fill the board without getting anywhere. Opening it shows a "Stopped after a failed run" note with the error. Fix the cause, then click **Resume**.

When an agent task's run fails, its task is moved to **Needs you** on the board, with a badge saying what went wrong (usually **Failed**) and a note naming the agent and the error, so it does not sit in **To do** looking like work waiting to be picked up. The routine files a new task on its next run, so you can dismiss the old one or give it to an agent yourself.

An OpenClaw cron job is different: the Gateway owns it, so a failed run shows `failed` but the job stays enabled.

## Verify it worked

- The new routine appears under **Team routines** or **Agent routines** with a live countdown (`in 5m`, `in 1h`).
- When it runs, the pill moves through `queued`, `starting`, and `running`, then back to `on`, and the row shows `ran <time>`.
- A team routine's message appears in the team chat under a **Routine** label that names the routine and who it went to, and the lead's reply follows.
- An agent routine's task appears on [the board](/using/board). Its result is on the task card, and **View task** in the routine's recent runs opens it.
- Each run is traced in the [Observability dashboard](/using/observability-dashboard) through the `routine_*` events.

## Troubleshooting

<Warning>
**A routine says "Team not found" or "Agent not found".** The team or agent it points at was deleted after the routine was made. Its next run will fail, so edit the routine to send it somewhere else, or delete it.
</Warning>

<Warning>
**A team routine failed with "The team has no active members."** Nobody was on the team to take the message. Add an agent to the team, then resume the routine.
</Warning>

<Warning>
**A routine failed with "The team ... is archived" or "The agent ... was removed."** What the routine points at is gone. Edit the routine to send it somewhere else, then resume it, or delete it.
</Warning>

<Warning>
**An OpenClaw agent's routine failed with `gateway_disconnected`.** The Gateway was not connected when the routine ran. Connect it (see [System & maintenance](/using/system-maintenance)), then resume the routine.
</Warning>

<Warning>
**An agent routine failed with `dispatch refused: ...`.** The executor would not start the run, for example because a budget cap paused the agent (`budget_paused`), or because a routine with a `repoPath` could not get a worktree of that repository (`workspace_unavailable`). Fix the cause, then resume the routine.
</Warning>

## Related

- [Schedule recurring team work](/guides/recurring-team-work): a walkthrough, including the API
- [Scheduling](/concepts/scheduling): the model behind routines: the ledger, the ticker, and what a run does
- [Group chat](/using/group-chat): where a team routine's message and the lead's work appear
- [The board](/using/board): where an agent routine's task lands
- [Schedules API](/reference/rest-api/schedules): request and response shapes and status codes
- [Observability dashboard](/using/observability-dashboard): a run's trace
