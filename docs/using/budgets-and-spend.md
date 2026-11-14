---
title: 'Track spend and set budgets'
sidebarTitle: 'Budgets and spend'
description: 'See what your agents spend and where each figure comes from, then set a warn-only or hard-cap budget in the Governance panel.'
keywords:
  [
    'budget',
    'budgets',
    'spend',
    'cost',
    'cost and budgets',
    'Tokens Used',
    'cost dashboard',
    'Governance',
    'governance dashboard',
    'hard cap',
    'warn only',
    'kill-switch',
    'audit log',
    'estimate',
  ]
---

Clawboo itself is free. The providers you connect bill you for model usage, and Clawboo shows what your agents spend so you can keep track of it. A **budget** puts a dollar limit on an agent, a team or a chain of hand-offs. It warns you by default; a **hard cap**, which pauses work at the limit, is something you turn on.

Use this page to read the spend figures, set a budget, and resume one that paused. [Budgets and guardrails](/concepts/governance) explains the model behind it.

## Where spend shows

| Where                                                 | What it shows                                                                    | What it covers                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| **Settings** > **Insights** > **Tokens Used**         | Token counts for today, the last 7 days and the last 30 days, by team and agent  | Every runtime                             |
| A task's card and drawer on the [Board](/using/board) | What the task's runs cost. `~$0.02 est.` is an estimate; `free` is a local model | Board tasks whose runs recorded a cost    |
| **Settings** > **Insights** > **Governance**          | Each budget's spend against its limit                                            | Work charged to a scope that has a budget |
| **Settings** > **Insights** > **Fleet**               | **Spend · 24h**: the total cost of board tasks that changed in the last 24 hours | Board tasks                               |

None of these is your bill. Your provider's own billing page shows what you were charged. When an agent runs on a ChatGPT plan, you pay the plan's fee, and Clawboo's figures are only a guide for your budgets.

## Where each cost comes from

Some runtimes report what a run cost. For the others, Clawboo estimates it. Estimates count toward budgets the same way as reported figures, and the Board marks them **est.**

| Runtime                            | What it reports to Clawboo       | What Clawboo records                                                                                   | Marked est. |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| Claude Code                        | The dollar cost of each run      | That figure                                                                                            | No          |
| Clawboo Native, on a priced model  | Token counts for each model turn | The cost at Clawboo's list price for that model                                                        | No          |
| Clawboo Native, on any other model | Token counts for each model turn | The tokens priced from Clawboo's rate table, or at the default rate when the model is not in it        | Yes         |
| Codex                              | Token counts, no dollar figure   | The tokens priced at the default rate, because Clawboo has no prices for Codex models                  | Yes         |
| Hermes                             | Token counts, no dollar figure   | The tokens priced from Clawboo's rate table, or at the default rate when the model is not in it        | Yes         |
| OpenClaw                           | No cost with its runs            | An estimate from the length of the prompt and the reply, for every team-chat run and every routine run | Yes         |

- **The priced models** are claude-haiku-4-5, claude-sonnet-4-6, gpt-4o and gpt-4o-mini, plus the OpenRouter ids anthropic/claude-haiku-4.5 and openai/gpt-4o-mini. The default leader models, claude-sonnet-5 and gpt-5.4, are not among them.
- **The rate table** lists Anthropic's Claude models plus gpt-4o and gpt-4o-mini. **The default rate** is $3 per million input tokens and $15 per million output tokens.
- **Length estimates** count about four characters as one token, then apply the model's rate.
- **Runs that end without a report.** A run that reports neither a cost nor token counts gets a length estimate, marked **est.**, in team chat, one-to-one chat, routines and API runs alike. That includes a Claude Code run that fails or is stopped before it reports its cost, and an OpenClaw routine run that fails, times out or is stopped.
- **Local Ollama models cost nothing.** A run on a model your own Ollama serves is recorded at $0, charges no budget, and reads **free** on the Board. That covers a Clawboo Native agent on the Ollama provider and an OpenClaw agent whose model in `openclaw.json` is an `ollama/` one. Ollama's cloud models (a `-cloud` tag) run on ollama.com, so they keep the default rate. Clawboo tells them apart by that tag alone, so a cloud model you copied under a name without it counts as free.
- **Tokens Used** counts OpenClaw differently: it shows the token counts the OpenClaw Gateway records for each turn. Those counts and the budget's estimate for the same turn can differ. The other runtimes are listed with the figures their runs record.

The runtime pages repeat these rules with their setup: [Clawboo Native](/runtimes/native), [OpenClaw](/runtimes/openclaw), [Claude Code](/runtimes/claude-code), [Codex](/runtimes/codex) and [Hermes](/runtimes/hermes).

## Read Tokens Used

Open **Settings** (the **Settings** row in the sidebar, or `Cmd/Ctrl + ,`), then **Insights** > **Tokens Used**.

- **Today**, **This Week** and **This Month** show token counts, not dollars. **This Week** covers the last 7 days and **This Month** the last 30, each counted from midnight on the computer running Clawboo. A count turns amber at 10,000 tokens and red at 100,000.
- **Tokens by Team** lists every agent, grouped by team, with agents outside a team under **Unassigned**. Each row shows a bar for the agent's share and its input and output tokens; hover them for exact counts.
- The chart below shows daily totals for the last 30 days, with empty days at zero.

Tokens Used counts every runtime. An OpenClaw agent is counted turn by turn from the Gateway's own token counts: its one-to-one chat, its team-chat turns and its routines. Clawboo Native, Claude Code, Codex and Hermes agents are counted run by run: Board and API runs, routines, team-chat runs and one-to-one chat turns, whether or not the agent has a budget. A run that reported no token counts is counted from the length of its prompt and reply. Work from before each of these was counted is not backfilled, and an OpenClaw agent that runs on your Gateway but is not in Clawboo is not counted.

The panel loads its figures once, when you open it. Close it and open it again to see new usage.

## What counts against a budget

A budget counts spend only from the moment you create it, and only for its own scope:

- **Team chat**, meaning General, rooms, team routines, tasks you give an agent on the Board, and the tasks a leader hands off from there: charged to the agent and the team, and to the mission when the run works on a task.
- **Agent routines and runs started through the API** on Clawboo Native, Claude Code, Codex or Hermes: charged to the agent, the mission and the team. A run that reports no cost is charged an estimate when it ends. When a reviewer checks the work, its run is charged the same way, to the same agent.
- **OpenClaw agent routines**: charged to the agent, the mission and the team, from an estimate when the run ends, whether it succeeded, failed, timed out or was stopped.
- **One-to-one chat with a Clawboo Native, Claude Code, Codex or Hermes agent**: charged to that agent. A turn that reads the results of work handed to a team is also charged to that team and to the job those results are from.
- **One-to-one chat with an OpenClaw agent**: shows on **Tokens Used**, but no budget is charged.

A **mission** is one chain of hand-offs, counted on its top task: the first task in the chain.

An agent's budget is set on the agent, so it follows the agent when you [move it to another team](/using/agents#move-an-agent-to-another-team). A team's budget stays with its team.

## Set a budget

### Create the budget

<Steps>

<Step title="Open Governance">

Open **Settings** > **Insights** > **Governance**. The **Budgets** section lists your budgets, or reads **No budgets yet**.

</Step>

<Step title="Pick the scope">

In the form below the list, pick **agent**, **team** or **mission**.

</Step>

<Step title="Pick who it covers and the limit">

In the next list, choose the agent, team or board task by name; type to search. Agents show their team, so two agents with the same name stay apart, archived teams are left out, and for a mission the list holds the top-level board tasks, newest first. Enter the limit in dollars in the next field, which reads **warn at $** (or **cap $** once you pick a hard cap). The smallest limit is $0.01.

If what you picked already has a budget, a line under the form says so, for example `This already has a hard cap budget of $5.00.`, and the form switches to that budget's mode. **Set budget** then changes that budget instead of adding a second one.

</Step>

<Step title="Pick the mode">

Pick **warn only** (selected at first, unless what you picked already has a budget) or **hard cap**. See the next section for the difference.

</Step>

<Step title="Save it">

Press **Set budget**.

You should see a row with the scope, the agent, team or task by name (or its id, once it is deleted), a **warn** or **cap** pill, the status **active**, the spend against the limit (for example `$0.00 / $5.00`) and a bar. The list refreshes every 5 seconds while the panel is open.

</Step>

</Steps>

If no row appears, Clawboo refused the budget, for example because the limit was $0. The form clears without a message, so check the list. A budget cannot be deleted. To stop one from pausing work, raise its limit, or save it again as **warn only**.

## Warn only or hard cap

| Status reached         | **warn only** (the default)           | **hard cap** (you opt in)                                   |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------- |
| Under 80% of the limit | **active**                            | **active**                                                  |
| 80% or more            | **soft_capped** (amber)               | **soft_capped** (amber)                                     |
| 100% or more           | Stays **soft_capped**. Nothing pauses | **paused** (red), and Clawboo stops work as described below |

Hover a row's mode pill to read it in a few words: **warn** says "Track-and-warn: never auto-pauses", and **cap** says "Hard cap: auto-pauses at 100%".

When any run takes a budget past 80% or 100% (an agent routine, a run started through the API, an OpenClaw routine, team chat, a one-to-one chat or the peer exchange), Clawboo also writes a `budget` entry to the audit log. Setting a limit and resuming a budget write one too, with the budget before and after the change, and so does creating a Clawboo Native agent with a budget.

## What a hard cap stops

A paused hard cap refuses new runs on every path below. Whether it also stops a run that is already going depends on where the work runs:

| Where the work runs                                                         | Before a run starts                                                                                       | While a run is going                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Team chat: General, rooms, team routines, Board tasks and hand-offs         | The run is refused                                                                                        | A Clawboo Native run on a priced model stops after its next model turn. Every other run is charged when it ends, so it finishes                                                                                                                                          |
| Agent routines and API runs on Clawboo Native, Claude Code, Codex or Hermes | The run is refused                                                                                        | A run that keeps working past the cap is stopped. Claude Code and Codex report their cost only as the run ends, so their work is already done: the result is kept and posted, and the next run is refused. A run with no cost report is charged an estimate when it ends |
| OpenClaw agent routines                                                     | The run is refused                                                                                        | The run finishes. Its estimate is charged when it ends, whether it succeeded or not, and the next run is refused                                                                                                                                                         |
| One-to-one chat with a Clawboo Native, Claude Code, Codex or Hermes agent   | The turn is refused when the agent's budget is paused, or the team's or job's when it reads their results | A Clawboo Native run on a priced model stops after its next model turn. Every other run is charged when it ends, so it finishes                                                                                                                                          |

What you see when a hard cap stops work:

- **A run started through the API** that a cap stops is cancelled, and its task goes back to **To do** with the comment `Auto-paused: <scope> budget reached. Raise the cap (or resume) to continue.` A run refused before it starts answers `422` with the reason `budget_paused` (or `budget_held`; see [Runs that go at the same time](#runs-that-go-at-the-same-time)) and leaves the task as it was.
- **A run whose last cost report crossed the cap** (the usual case for Claude Code and Codex) had already ended, so it is not stopped: its result is posted, its task moves on as usual, and the comment reads `Budget cap reached (<scope>) by this run's final cost report. The run had already ended, so what it produced is kept; the next run is refused until you raise the cap or resume.` When the work gets a review, the review still runs and is charged to the same budgets, so the spend can end a little further past the limit.
- **An agent routine** counts the refused or stopped run as a failure. The routine stops until you resume it, and its task waits in **Needs you**; see [When a routine stops](/using/routines#when-a-routine-stops).
- **An OpenClaw routine** whose estimate crosses the cap leaves the comment `Budget cap reached (<scope>). This run is recorded; the next scheduled fire is blocked until you raise the cap or resume.`
- **Team chat and one-to-one chat**, before a run starts: Clawboo checks the agent's budget, the team's and, for a run that works on a task, the mission's (one-to-one chat checks the budgets it is charged to: the agent's, plus the team's and the job's when it reads their results). A reviewer asks too, and a cap that refuses it leaves the check without a review, with the reason on the check. When a hard cap among them is paused, nothing runs, and the chat shows `The <scope> budget is paused at its hard cap, so this run did not start. Raise the cap or resume it in Governance to continue.` A handed-off task, or a task you gave an agent on the Board, is not started either: it waits in **Needs you** with that sentence in a comment, and for a hand-off, the agent that handed it off is told.
- **A team routine** whose message is refused that way counts as a failed run with that sentence as its error, and stops until you resume it. If the lead was busy when the routine fired, the fire already counted as posted, so the refusal shows only in the chat.
- **Team chat and one-to-one chat**, during a run: a stopped run that had not replied yet leaves the message `The run failed: the run was stopped by a budget cap`. In team chat, a handed-off task it was working on waits in **Needs you**.

A run that is already going when its budget pauses usually finishes. To end it at once, press **Stop** in the team's chat. [What a hard cap stops](/concepts/governance#what-a-hard-cap-stops) has the full rules.

## Runs that go at the same time

Clawboo runs up to eight agent runs at once by default, so several runs can start together against the same budget: teammates in one team, or one agent's task, chat turn and routine. If each of them only checked what the budget had spent so far, all of them could pass the check together and take a hard cap past its limit together. So each run **holds** its estimated cost on every budget it counts toward, from the moment it is let start until it ends, and each new run sees what the others hold.

On a **hard cap**:

- A run with no other run going against the budget starts whenever the cap is not paused, as before.
- A run that would go at the same time as others starts only if what the budget has spent, plus what the runs already going still hold, plus its own estimate, fits under the limit.
- Otherwise it does not start, and you see `The <scope> budget is close to its hard cap, and runs already going have set aside the rest of it, so this run did not start. Try again when they finish, or raise the cap in Governance.` It shows wherever a paused cap's notice shows; the list below says what happens to each kind of run.

A **warn only** budget never holds a run back.

How a hold works:

- **The estimate.** A run holds the most that any of its agent's last 10 recorded runs cost (the records **Tokens Used** lists; an OpenClaw run recorded turn by turn counts as one run), or 50 cents for an agent with none yet. It is an estimate: a run can cost more or less than any run before it.
- **A second check before the model call.** A run that took a moment to get ready (its worktree, its memory, its prompt) is checked again right before it calls the model. A cap that paused meanwhile refuses it then, before anything is spent. A task-runner run refused at that point goes back to **To do** with the notice in a comment. A task-runner run that runs out of turns or room and would carry on in a fresh session is checked first too: if a hard cap it counts against has paused meanwhile, it stops there, like a run a cap stopped.
- **Settling.** As the run's cost is recorded, it replaces the estimate. When the run ends, however it ends (a reply, a failure, **Stop**, a run that went quiet and was ended), its hold goes, and only what it spent is left on the budget.
- **After a restart.** Clawboo runs one server per data directory (the `clawboo` command never starts a second one), so a server that starts drops every hold it did not take itself: those left by a server that crashed, was force-quit or restarted while its runs were going. If the database is busy at that moment, it tries again every 30 seconds.

What holds do not do: they do not stop a single run at the cap (see [What a hard cap stops](#what-a-hard-cap-stops)), and because they are estimates, runs that cost more than their estimates can still take a budget past its limit together. The hard cap then pauses, with the same effect on the runs going as any pause.

**Usage with no known price follows the budget's mode.** A run on a model Clawboo has no price for is held and charged at the default rate ($3 per million input tokens, $15 per million output tokens), so it counts toward a budget like any other run. A hard cap can refuse it or hold it back beside other runs, and pauses when its spend reaches the limit; a warn-only budget counts it and warns, and never stops it. A model your own Ollama serves is free and is never charged.

Where a run refused this way goes next:

- **A run started through the API** answers `422` with the reason `budget_held` and leaves the task as it was.
- **An agent routine** keeps its schedule: the refusal is a failure that may pass by itself, and three in a row stop the routine, as with a rate limit. See [When a routine stops](/using/routines#when-a-routine-stops).
- **A team routine** whose message is refused counts as a failed run and stops until you resume it, as with a paused cap.
- **Team chat and one-to-one chat**: send the message again once the other runs finish. A handed-off task waits in **Needs you**.
- **A task update** on its way to a lead or a chat waits, with no try counted against it, and goes out by itself within about 30 seconds of the room coming back. The chat says why once. A paused cap is different, since only you can raise that one: team chat says the update could not be delivered, a one-to-one chat keeps it for your next message, and the result stays on its card either way.

## Resume or raise a budget

A paused budget shows a **Resume** button on its row.

- **Resume** puts the budget back to **active** at once, without changing the limit. If spend is still at or over the limit, a message warns you and the row shows **will re-pause**: the next recorded spend pauses it again.
- **Set cap** changes the limit. Type the new amount in the row's **new cap $** field and press **Set cap**. It keeps the row's mode. A limit above the current spend un-pauses the budget: it reads **active** again, or **soft_capped** while spend is still 80% of the new limit or more.

To give a paused budget room, use **Set cap** with a higher limit. Then restart what it stopped, for example with **Retry** on its task in **Needs you**, **Resume** on the routine under **Settings** > **Workspace** > **Routines**, or by sending your message again.

You can also change a budget from the form below the list: pick the same agent, team or task, and the form switches to that budget's mode. Enter the new limit, pick the other mode if you want to change it, and press **Set budget**. A save that names no mode, such as a `POST /api/governance/budgets` without `mode`, keeps the budget's mode.

## Try a budget out first

To see how a budget behaves without pausing anything, start with **warn only**:

<Steps>

<Step title="Set a small warn-only budget">

Create a **warn only** budget with a small limit, such as $0.25, on one team.

</Step>

<Step title="Use the team">

Give the team some work in its chat, then watch the budget's row in **Governance**. The bar fills as runs are charged.

</Step>

<Step title="Watch the status">

At 80% the status turns **soft_capped** (amber). At 100% it stays amber, and nothing pauses.

</Step>

<Step title="Switch to a hard cap when you are ready">

In the form, pick the same scope and the same agent, team or task, enter the limit you want, pick **hard cap**, and press **Set budget**. The spend so far is kept, so if it is already at or over the new limit, the budget pauses at once.

You should see the **cap** pill on the row.

</Step>

</Steps>

## Read the audit log

The **Audit log** at the bottom of **Governance** keeps a record of what Clawboo's guardrails did, newest first, up to 200 entries at a time. Each entry shows the time of day, the event type, the start of the agent's id and a one-line summary. Narrow it with the **agent id** box (the full id), the event type list and **All**, **1h**, **24h** or **7d**. It reloads when you change a filter or press **Refresh** at the top of the panel.

The event types that matter for spend:

| Event type      | What it records                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget`        | A budget passing 80% or 100% on an agent routine, an API run or an OpenClaw routine, and each run a hard cap auto-paused or finished past       |
| `cap_hit`       | A team-chat turn that tried to start more hand-offs than the fan-out cap allows, a plan too long, or a hand-off over the child or top-level cap |
| `circuit_break` | A circuit breaker stopping an agent routine or API run that was going nowhere                                                                   |
| `board`         | A person setting a team's task id letters, changing a label, or changing a task's labels                                                        |
| `approval`      | Decisions on risky hand-offs, and unanswered approvals that Clawboo's cleanup expired                                                           |

Resuming a budget writes no entry, and neither does a run a budget refused, or spend in team chat or one-to-one chat.

## The rest of the Governance panel

- **Caps (enforced in code)** shows three chips you cannot change. **max spawn depth** 2 means a task can have at most two tasks above it, so a chain of hand-offs is three tasks deep. **max fan-out** 8 is the most hand-offs one team-chat turn can start. **per-node cost** names a per-run cost limit that only a routine set up through the API can carry; the chip is not a limit in force. [Budgets and guardrails](/concepts/governance#caps-on-delegation-and-task-creation) explains each one.
- **Approval queue** lists every pending approval from every team. See [Approvals](/using/approvals).

## Troubleshooting

<AccordionGroup>

<Accordion title="My budget passed 100% and nothing stopped">

A **warn only** budget never pauses anything; switch it to **hard cap** (see [Resume or raise a budget](#resume-or-raise-a-budget)). A hard cap refuses new runs, but a run already going stops partway only on Clawboo Native with a priced model. Other runs finish, and their cost is charged when they end, so the budget can end up past 100%. See [What a hard cap stops](#what-a-hard-cap-stops).

</Accordion>

<Accordion title="The budget is paused, but the team still runs">

New runs are refused once a hard cap pauses, but a run that was already going finishes, unless it is Clawboo Native on a priced model, which stops after its next model turn. Press **Stop** in the team's chat to end what is running. If new messages still get answers, check the budget's mode pill: a **warn** budget never pauses.

</Accordion>

<Accordion title="A run did not start, but the budget is not paused">

Other runs were going against the same hard cap, and together with the new run's estimate they would not fit under the limit. The notice reads `The <scope> budget is close to its hard cap, and runs already going have set aside the rest of it, so this run did not start.` Wait for those runs to finish and send the message again (or press **Retry** on the task), or raise the limit with **Set cap**. See [Runs that go at the same time](#runs-that-go-at-the-same-time).

</Accordion>

<Accordion title="I resumed a budget and it paused again at once">

Spend is still at or over the limit, which the **will re-pause** pill on the row tells you. Raise the limit with **Set cap**, then resume what it stopped.

</Accordion>

<Accordion title="My hard cap turned into warn only">

Someone saved it again with **warn only** picked, or sent `"mode": "warn"` through the API. Pick the same scope and the same agent, team or task in the form, pick **hard cap**, and press **Set budget**. Use **Set cap** on the row whenever you only want a new limit.

</Accordion>

<Accordion title="Set budget did nothing">

With no agent, team or task chosen, or a limit that is not a number, the button does nothing. With a limit of $0, Clawboo refuses the budget and the form clears without a message. Enter a limit of at least $0.01.

</Accordion>

<Accordion title="The budget's bar never moves">

A budget made through the API for an id that matches nothing is never charged, because the API accepts any id. A **tenant** budget is never charged either. A budget also counts only spend after it was created, and some work charges no budget at all: one-to-one chat with an OpenClaw agent, and anything on a local Ollama model, which costs nothing.

</Accordion>

<Accordion title="Couldn't load budgets.">

The panel could not read the budget list from Clawboo's server. Press **Retry** in the alert. If the alert stays, check that Clawboo is still running.

</Accordion>

<Accordion title="Tokens Used shows zero for an agent">

Tokens Used lists Clawboo Native, Claude Code, Codex and Hermes runs only from the release that added them, so earlier work reads zero. Their one-to-one chat turns are listed only from the release that started counting them. An OpenClaw agent's turns count only when Clawboo's server sees them and can match them to an agent in Clawboo.

</Accordion>

<Accordion title="An Ollama run shows a cost">

A model your own Ollama serves is free, so its runs read **free** and charge no budget. A cost means the run was not recognized as local: one of Ollama's cloud models (a `-cloud` tag), which runs on ollama.com, or an OpenClaw agent whose model in `openclaw.json` is not an `ollama/` one.

</Accordion>

<Accordion title="The bar is amber, but the audit log shows no warning">

A warning is written once, on the charge that crosses 80% or 100%. A bar that was already past the line before this release, or a budget created already over it, has no crossing left to record. A spend that could not be recorded writes no warning either.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- **Statuses and modes.** Budgets are stored with the modes `warn` and `cap` and the statuses `active`, `soft_capped` and `paused`. A `warn` budget never reads `paused`. Spend is kept in fractions of a cent, so many tiny costs add up, and each scope (agent, mission, team) is updated in its own write.
- **Holds.** Each run that is going has one row per budget it counts toward in the `budget_reservations` table, with what it still holds. A hold is taken and checked in one database transaction, so two runs can never both read the same room under a cap. If the hold cannot be written (the database busy past its retry time), the run goes without one, but a paused hard cap still refuses it whenever the budgets can be read. See the [database schema](/reference/database-schema#budget_reservations).
- **Budgets over REST.** `GET /api/governance/budgets` lists them. `POST /api/governance/budgets` takes `{ "scope", "scopeId", "limitUsdCents", "mode" }`, where `limitUsdCents` is a positive whole number. A new budget without `mode` is `warn`; saving an existing scope updates its limit, and its mode only when you send one. `POST /api/governance/budgets/:scope/:scopeId/resume` resumes a budget and answers `willRepause`; when spend is at or over the limit, an optional `graceUsdCents` raises the limit to the current spend plus the grace and keeps the mode. There is no delete route.
- **The audit log over REST.** `GET /api/governance/audit` takes `agentId`, `eventType`, `since` and `limit` (at most 1,000).
- **Another way to get a hard cap.** Creating a Clawboo Native agent through the API with `budgetUsd` also creates a hard-cap budget for that agent.
- **Run costs.** Each run records its cost with a source of `reported`, `local`, `token-estimate` or `char-estimate`. A task's total reads as an estimate when any of its runs is neither `reported` nor `local`, and as free when all of them are `local`.
- **Tokens Used** reads `GET /api/cost-records/summary`. Clawboo's server writes one cost record for each OpenClaw turn it can match to an agent in Clawboo, and one for each run of the other runtimes, a one-to-one chat turn included.
- Shapes and codes: [Governance API](/reference/rest-api/governance) and [Costs and fleet API](/reference/rest-api/costs).

</Accordion>

## Next steps

- [Budgets and guardrails](/concepts/governance): the model behind budgets, caps and circuit breakers, path by path.
- [Approvals](/using/approvals): answer the requests in the **Approval queue**.
- [Routines](/using/routines): resume a routine that a hard cap stopped.
- [Board](/using/board): read what each task cost.
- [Limits and defaults](/reference/limits-and-defaults): every threshold and waiting time in one place.
