---
title: 'Run work on a schedule with routines'
sidebarTitle: 'Routines'
description: 'Create routines that send a team or one agent its instructions on a schedule, follow their runs, and resume one that stopped after a failure.'
icon: 'repeat'
keywords:
  [
    'Scheduler',
    'schedule',
    'cron',
    'recurring work',
    'once@',
    'Schedule recurring team work',
    'automation',
  ]
---

A **routine** sends instructions to a team or to one agent on a schedule, with nobody at the dashboard: a morning briefing, an hourly inbox check, a weekly report. Use this page to create one, pick its schedule, follow its runs, and get one going again after it stops. What happens inside the scheduler is in [How routines run](/concepts/scheduling).

## Team routine or agent routine

Each routine is one of two kinds. Choose by who should do the work:

|                        | **A team task**                                                                                                                         | **An agent task**                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| What each run does     | Posts your instructions in the team's **General** chat. The team's lead answers or brings in teammates, as if you had typed the message | Puts a new task on the board for one agent, which starts on it right away   |
| Where the result shows | The team chat, and the board for any work the lead hands out                                                                            | The task's card on the board, which the team chat shows too                 |
| Good for               | Work that may need several agents                                                                                                       | A clear chore one agent owns                                                |
| Example                | "Every weekday at 9am, summarize what the team finished yesterday and flag anything blocked."                                           | "Every hour, check the support inbox and draft replies to anything urgent." |

The lead is Boo Zero when you have one, otherwise the team's Leader, otherwise its first active member. Instructions that start with `@Name` go to that teammate instead.

## Before you begin

- A team task needs a team with at least one member. An agent task needs an agent; agents on no team can have routines too.
- Agents on OpenClaw need the OpenClaw Gateway connected when the routine runs.
- Clawboo must be running. Routines fire from the Clawboo server, so nothing runs while it is stopped or the computer sleeps.

## Create a routine

<Steps>

<Step title="Open Routines">

Open **Settings** (the gear in the sidebar, or **Cmd/Ctrl + ,**) and choose **Routines** under **Workspace**. You can also start from an agent's page: **New routine** in its **Tasks & Routines** card opens the same dialog, set up as an agent task for that agent.

</Step>

<Step title="Start a new routine">

Click **New routine**. Under **Who it is for**, choose **A team task** or **An agent task**.

</Step>

<Step title="Pick who gets it">

Pick the **Team**, and for an agent task the **Agent** on it. Agents on no team are listed under **No team (standalone agents)**.

</Step>

<Step title="Write the instructions">

Under **What should happen**, write what each run should do. For a team task this is the message the lead receives; for an agent task it is the task's description. Write it so the work can be done without asking you anything: a team lead is told you may not be watching, and to make reasonable assumptions and state them.

</Step>

<Step title="Name it">

Optionally give it a **Name**. Without one, it is named after the first line of the instructions.

</Step>

<Step title="Choose when it runs">

Under **Runs**, pick a preset or **Custom** (see the next section). The dialog shows when the next run would be.

</Step>

<Step title="Create it">

Click **Create routine**. The routine appears under **Team routines** or **Agent routines** with an **on** pill and a countdown such as `in 5m`.

</Step>

</Steps>

While **Create routine** is disabled, the line beside it says what is missing, such as "Choose an agent." A team with no members shows a warning, because nobody would pick the routine up.

## Choose a schedule

| Preset                       | Runs                           | Cron           |
| ---------------------------- | ------------------------------ | -------------- |
| **Every 5 minutes**          | Every 5 minutes                | `*/5 * * * *`  |
| **Every 15 minutes**         | Every 15 minutes               | `*/15 * * * *` |
| **Every 30 minutes**         | Every 30 minutes               | `*/30 * * * *` |
| **Every hour** (the default) | On the hour                    | `0 * * * *`    |
| **Every 6 hours**            | At 0:00, 6:00, 12:00 and 18:00 | `0 */6 * * *`  |
| **Every 12 hours**           | At 0:00 and 12:00              | `0 */12 * * *` |
| **Daily · 9am**              | 9:00 every day                 | `0 9 * * *`    |
| **Weekdays · 9am**           | 9:00 Monday to Friday          | `0 9 * * 1-5`  |
| **Weekly · Mon 9am**         | 9:00 every Monday              | `0 9 * * 1`    |

**Custom** takes a cron expression: minute, hour, day of month, month and day of week. For example, `30 8 * * 1-5` runs at 8:30 on weekdays. For a single run at a set time, type `once@` followed by a date and time, such as `once@2026-12-01T09:00:00Z`. The `Z` means UTC; leave it off to use the local time of the machine that runs Clawboo. After that run it reads **finished** and never runs again; a time in the past is refused with "This schedule never runs again."

Times follow the clock and time zone of the machine that runs Clawboo. If Clawboo was stopped or the computer was asleep when a routine was due, it runs once when Clawboo is back, then carries on with its schedule; missed times are not made up. A routine never runs twice at once: a time that passes while a run is still going is skipped. Routines are saved in Clawboo's database, so they carry on after a restart; a run cut off by the restart shows as **interrupted**.

## What a run does

|                                   | Team task                                                                      | Agent task on Clawboo Native, Claude Code, Codex or Hermes | Agent task on OpenClaw                                                  |
| --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Each run                          | Posts the instructions in General, labelled **Routine** and the routine's name | Files a new task for the agent and runs it                 | Files a new task and sends it to the agent through the OpenClaw Gateway |
| Needs                             | A team member to answer                                                        | The agent's runtime connected                              | The Gateway connected                                                   |
| Counts as done                    | When the message reaches the lead (**posted**)                                 | When the task finishes (**done**)                          | When the task finishes (**done**)                                       |
| Gets from [Memory](/using/memory) | Nothing automatically; agents search it as needed                              | The most relevant facts, at the start of the run           | Nothing automatically                                                   |
| Time limit                        | Ends after 30 minutes with no activity                                         | Ends after 30 minutes with no activity                     | Ends after 10 minutes in total                                          |

Budgets apply to routine runs like any other work, and an agent task is refused before it starts when a hard-cap budget it falls under is already paused; see [Budgets and spend](/using/budgets-and-spend). [How routines run](/concepts/scheduling) lists the other guardrails each kind gets.

A routine made in the dashboard has no repository, so its agent tasks run without a git worktree, in the team's folder. Claude Code, Codex and Hermes run with their own permission prompts turned off and can read and change any file your user account can; see [What agents can do](/concepts/permissions).

Agents may also need your approval mid-run, for example for a connector call. A routine runs while you may be away, and a call nobody approves in time is refused, so prefer tools that do not ask for routine work.

## Follow a routine's runs

The Routines view groups rows under **Team routines**, **Agent routines** and, if you use OpenClaw, **OpenClaw's own cron jobs**. It refreshes itself every few seconds while it is open; **Refresh** reads it at once. Each row shows the routine's name, its status, where it goes (for example `Research team chat · Boo Zero leads`, or `Ada · Research` for an agent on the Research team), how often it runs, its next run and its last run.

| Pill                                  | Meaning                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| **on**                                | Waiting for its next run                                                               |
| **queued**, **starting**, **running** | A run is on its way or under way                                                       |
| **paused**                            | You paused it. It does not run until you resume it                                     |
| **failed**                            | Its last run failed, and it stopped. See [When a routine stops](#when-a-routine-stops) |
| **finished**                          | A one-time routine that already ran                                                    |
| **disabled**                          | An OpenClaw cron job that is turned off on the Gateway                                 |

Click a row to open the routine:

- **Sends to** names the team chat and its lead (with **Open team chat**), or the agent, its team and its runtime.
- **What happens** shows the instructions, **Schedule** shows how often it runs and when next, and **Last run** shows when it last ran.
- **Recent runs** lists the last ten runs, newest first, with how long each took. A team run reads **posted**; an agent run reads **done** once its task is finished, and **View task** opens that task with the agent's report. A run cut off because Clawboo stopped reads **interrupted**.

Elsewhere, the [board](/using/board)'s calendar shows upcoming runs in **To do** as strips with the routine's name and time; click one to see its schedule or run it now. Each run's events also appear in [Observability](/using/observability).

## Change, pause, run or delete

The buttons at the bottom of an open routine, and the shortcuts at the right of its row, do the following:

| Button                 | What it does                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Edit**               | Change who it is for, the instructions, the name or the schedule, then **Save changes**. Changing the schedule of a paused or stopped routine does not turn it back on |
| **Pause** / **Resume** | Stop it from running until you resume it. Resuming sets its next run from the schedule. Neither works while a run is under way                                         |
| **Run now**            | Start a run straight away without changing the schedule. Only while the routine is **on**: resume a paused or stopped routine first                                    |
| **Delete**             | Asks first, then removes the routine. Tasks and messages it already produced stay                                                                                      |

A greyed-out button says why when you hover it, for example "resume it first" or "it is running now".

## When a routine stops

A routine whose run fails stops itself, on purpose: a routine that kept retrying a broken run would spend money and fill the board without getting anywhere. Its pill reads **failed**, the row shows the error, and the open routine says **Stopped after a failed run.** It does not run again until you resume it.

<Steps>

<Step title="Read the error">

Open the routine. The note under **Stopped after a failed run.** quotes the error; the table below lists the common ones.

</Step>

<Step title="Fix the cause">

Do what the table says, for example raise a budget or reconnect the Gateway.

</Step>

<Step title="Resume it">

Press **Resume**. The pill returns to **on**, and the routine runs at its next scheduled time. To check at once, press **Run now**.

</Step>

</Steps>

When an agent task's run fails, its task is set aside in **Needs you** on the board with a note naming the agent and the error, so it does not sit in **To do** looking like waiting work. The routine files a new task on its next run, so you can dismiss the old one or hand it to an agent yourself.

Two outcomes are not failures and leave the routine running: another agent had already claimed the task, or you moved the task's card on the board while the agent worked on it.

| Error                                                                                    | Cause                                                               | Fix                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `dispatch refused: budget_paused` (on OpenClaw, `budget_paused:` and the budget's scope) | A hard-cap budget the agent falls under is paused                   | Raise or resume the budget in **Governance**, then resume the routine. See [Budgets and spend](/using/budgets-and-spend) |
| `gateway_disconnected`                                                                   | An OpenClaw agent's routine ran while the Gateway was not connected | Connect the Gateway (see [OpenClaw](/runtimes/openclaw)), then resume the routine                                        |
| The team has no active members.                                                          | Nobody was on the team to take the message                          | Add an agent to the team, then resume the routine                                                                        |
| The team this routine posts to no longer exists.                                         | The team was deleted                                                | Edit the routine to send it somewhere else, or delete it                                                                 |
| The team "..." is archived.                                                              | The team was archived                                               | Edit the routine to send it to another team, or delete it                                                                |
| `agent ... not found`, or The agent "..." was removed.                                   | The agent was deleted, or removed from the OpenClaw Gateway         | Edit the routine to send it to another agent, or delete it                                                               |
| Starts with `run`                                                                        | The agent's run itself failed or timed out                          | Open the task (**View task** in **Recent runs**) to see what went wrong                                                  |

An OpenClaw cron job is different: the Gateway owns it, so a failed run shows **failed** but the job stays enabled.

## OpenClaw's own cron jobs

The OpenClaw Gateway has a scheduler of its own that OpenClaw agents can use. The Routines view lists those jobs under **OpenClaw's own cron jobs**, so everything scheduled is in one place. You can **Disable** or **Enable**, **Run now** or **Delete** a job there, but not edit it: Gateway jobs are created in OpenClaw. While the Gateway is disconnected, a notice says the jobs are hidden until it reconnects, or that the list shown is the last one it sent. Your own routines are not affected.

## Example: a weekday briefing for a team

This walks through a team routine from creation to its first result.

<Steps>

<Step title="Create the routine">

Click **New routine**, choose **A team task** and pick the team. Under **What should happen**, write "Summarize what the team finished yesterday and flag anything that is blocked." Name it "Morning briefing", choose **Weekdays · 9am**, and click **Create routine**.

</Step>

<Step title="Try it now">

Open the routine and press **Run now**. Within a few seconds the run starts, and **Recent runs** gains an entry.

</Step>

<Step title="Read the result">

Press **Open team chat**. In General, a message labelled **Routine · Morning briefing** appears, followed by the lead's reply and any work it hands out. The routine's **Recent runs** shows the run as **posted**.

</Step>

<Step title="Check the schedule">

Open the [board](/using/board): the next runs appear in **To do** on the coming weekdays.

</Step>

</Steps>

An agent version works the same way: choose **An agent task** and pick the agent. Each run then files a task on the board, and **View task** in **Recent runs** opens it with the agent's report.

<Accordion title="Create and manage routines from the API">

`POST /api/schedules` creates a routine. This one posts to a team every weekday at 9:00:

```bash
curl -X POST http://127.0.0.1:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "target": "team",
    "teamId": "<team-id>",
    "cronSpec": "0 9 * * 1-5",
    "label": "Morning briefing",
    "taskTemplate": { "description": "Summarize what the team finished yesterday and flag anything that is blocked." }
  }'
```

For an agent routine, send `"target": "agent"` (the default) and an `agentId` instead of the `teamId`. The routine is filed on the agent's own team. A team or agent that does not exist or is archived, or a `teamId` that is not the agent's team, is refused with `400` and `code: "invalid_routine_target"`. A schedule Clawboo cannot read is refused with `400` and `code: "invalid_body"`, with the reason in `error`. Unlike the dialog, the API accepts a `once@` time in the past; that routine reads **finished** straight away.

The task template takes fields the dialog does not offer:

| Field                       | What it does                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repoPath`                  | Runs each agent task in its own git worktree of that repository, and checks any changes it makes before the task lands done (see [When work is checked](/concepts/verification)). The check needs a `VERIFY_CMD` in the worktree's `init.sh`. A repository Clawboo cannot check out fails the run with `dispatch refused: workspace_unavailable` |
| `kind`, `model`, `priority` | The task kind (default `code`), the model, and the task's priority                                                                                                                                                                                                                                                                               |
| `maxNodeCents`              | A spending cap for each run, in cents                                                                                                                                                                                                                                                                                                            |
| `teamTaskId`                | Runs one existing board task instead of filing a new one each time                                                                                                                                                                                                                                                                               |

A routine bound to an existing task with `teamTaskId` must be a one-time `once@` routine (`400`, `code: "bound_recurring_schedule"` otherwise), because a task can be claimed only once. Binding is refused with `409` and `code: "duplicate_firing_owner"` when another scheduler already owns that task. A team routine cannot be bound.

Routine ids look like `clawboo-routine:<id>`. `PATCH /api/schedules/:id` pauses or resumes (`{ "action": "pause" }`) or edits (`{ "patch": { "cronSpec": "0 8 * * 1-5" } }`), `POST /api/schedules/:id/run` runs it now and answers `202` at once, and `GET /api/schedules/:id/runs` returns the recent runs (ten by default). Full shapes and codes are in the [Schedules API reference](/reference/rest-api/schedules).

</Accordion>

## Troubleshooting

<AccordionGroup>

<Accordion title="A routine did not run at its time">

Check its pill. A **paused** or **failed** routine waits for you; resume it. If Clawboo was stopped or the computer was asleep at that time, the routine runs once when Clawboo is back. A time that passed while an earlier run was still going is skipped.

</Accordion>

<Accordion title="Run now or Pause is greyed out">

Hover the button to see why. A paused or stopped routine must be resumed before **Run now**, and nothing can be paused or resumed while a run is under way.

</Accordion>

<Accordion title="A row reads Team not found or Agent not found">

The team or agent the routine points at was deleted after the routine was made, so its next run will fail. Edit the routine to send it somewhere else, or delete it.

</Accordion>

<Accordion title="The agent asks questions in its reply and waits">

Nobody may be there to answer. Rewrite the instructions so the work can be done without asking: name the inputs, the output you want and where it should go.

</Accordion>

</AccordionGroup>

## Next steps

- [How routines run](/concepts/scheduling): missed runs, restarts, failures and the guardrails each kind of run gets.
- [Board](/using/board): upcoming routine runs on the calendar, and the tasks agent routines file.
- [Team chat](/using/team-chat): where a team routine's message and the lead's work appear.
- [Budgets and spend](/using/budgets-and-spend): cap what routine runs can spend.
- [Schedules API](/reference/rest-api/schedules): every field and status code.
