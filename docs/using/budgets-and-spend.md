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
| **Settings** > **Insights** > **Tokens Used**         | Token counts for today, the last 7 days and the last 30 days, by team and agent  | OpenClaw agents only                      |
| A task's card and drawer on the [Board](/using/board) | What the task's runs cost. A figure such as `~$0.02 est.` is an estimate         | Board tasks whose runs recorded a cost    |
| **Settings** > **Insights** > **Governance**          | Each budget's spend against its limit                                            | Work charged to a scope that has a budget |
| **Settings** > **Insights** > **Fleet**               | **Spend · 24h**: the total cost of board tasks that changed in the last 24 hours | Board tasks                               |

None of these is your bill. Your provider's own billing page shows what you were charged. When an agent runs on a ChatGPT plan, you pay the plan's fee, and Clawboo's figures are only a guide for your budgets.

## Where each cost comes from

Some runtimes report what a run cost. For the others, Clawboo estimates it. Estimates count toward budgets the same way as reported figures, and the Board marks them **est.**

| Runtime                            | What it reports to Clawboo       | What Clawboo records                                                                                               | Marked est. |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| Claude Code                        | The dollar cost of each run      | That figure                                                                                                        | No          |
| Clawboo Native, on a priced model  | Token counts for each model turn | The cost at Clawboo's list price for that model                                                                    | No          |
| Clawboo Native, on any other model | Token counts for each model turn | The tokens priced from Clawboo's rate table, or at the default rate when the model is not in it                    | Yes         |
| Codex                              | Token counts, no dollar figure   | The tokens priced at the default rate, because Clawboo has no prices for Codex models                              | Yes         |
| Hermes                             | Nothing                          | In team chat, an estimate from the length of the prompt and the reply. On routine and API runs, nothing at all     | Yes         |
| OpenClaw                           | No cost with its runs            | An estimate from the length of the prompt and the reply, for every team-chat run and for routine runs that succeed | Yes         |

- **The priced models** are claude-haiku-4-5, claude-sonnet-4-6, gpt-4o and gpt-4o-mini, plus the OpenRouter ids anthropic/claude-haiku-4.5 and openai/gpt-4o-mini. The default leader models, claude-sonnet-5 and gpt-5.4, are not among them.
- **The rate table** lists Anthropic's Claude models plus gpt-4o and gpt-4o-mini. **The default rate** is $3 per million input tokens and $15 per million output tokens.
- **Length estimates** count about four characters as one token, then apply the model's rate.
- **Runs that end without a report.** In team chat, a run that reports neither a cost nor token counts gets a length estimate, marked **est.** That includes a Claude Code run that fails or is stopped before it reports its cost. On agent routines and API runs, such a run records no cost.
- **Local Ollama models** are in neither list, so an Ollama run that costs you nothing still shows a cost at the default rate, marked **est.** Treat it as a placeholder.
- **Tokens Used** counts OpenClaw differently: it shows the token counts the OpenClaw Gateway records for each turn. Those counts and the budget's estimate for the same turn can differ.

The runtime pages repeat these rules with their setup: [Clawboo Native](/runtimes/native), [OpenClaw](/runtimes/openclaw), [Claude Code](/runtimes/claude-code), [Codex](/runtimes/codex) and [Hermes](/runtimes/hermes).

## Read Tokens Used

Open **Settings** (the **Settings** row in the sidebar, or `Cmd/Ctrl + ,`), then **Insights** > **Tokens Used**.

- **Today**, **This Week** and **This Month** show token counts, not dollars. **This Week** covers the last 7 days and **This Month** the last 30, each counted from midnight on the computer running Clawboo. A count turns amber at 10,000 tokens and red at 100,000.
- **Tokens by Team** lists every agent, grouped by team, with agents outside a team under **Unassigned**. Each row shows a bar for the agent's share and its input and output tokens; hover them for exact counts.
- The chart below shows daily totals for the last 30 days, with empty days at zero.

Tokens Used counts OpenClaw agents only: their one-to-one chat, their team-chat turns and their routines. Clawboo Native, Claude Code, Codex and Hermes agents are listed with zero tokens, however much they worked, so read their spend on the Board and in budgets. An OpenClaw agent that runs on your Gateway but is not in Clawboo is not counted.

The panel loads its figures once, when you open it. Close it and open it again to see new usage.

## What counts against a budget

A budget counts spend only from the moment you create it, and only for its own scope:

- **Team chat**, meaning General, rooms, team routines, tasks you give an agent on the Board, and the tasks a leader hands off from there: charged to the agent and the team, and to the mission when the run works on a task.
- **Agent routines and runs started through the API** on Clawboo Native, Claude Code, Codex or Hermes: charged to the agent, the mission and the team. Hermes records no cost on these runs.
- **OpenClaw agent routines**: charged to the agent, the mission and the team, from an estimate when a run succeeds. A run that fails or times out is not charged.
- **One-to-one chat with a Clawboo Native agent**: charged to that agent only, and only on a priced model.
- **One-to-one chat with an OpenClaw agent**: shows on **Tokens Used**, but no budget is charged.

A **mission** is one chain of hand-offs, counted on its top task: the first task in the chain.

## Set a budget

### Find the id first

The form asks for the scope's id, not its name, and the dashboard does not show full ids. Open the API in your browser, at the same address as your dashboard (use your own port):

- **Team ids**: `/api/teams`, for example `http://localhost:18790/api/teams`. Each team lists its `id` and `name`.
- **Agent ids**: `/api/agents`.
- **Mission ids**: `/api/board`. A mission's id is the id of its top task, the one whose `parentTaskId` is `null`.

Clawboo does not check the id you type. A budget for a mistyped id is created, but nothing ever charges it.

### Create the budget

<Steps>

<Step title="Open Governance">

Open **Settings** > **Insights** > **Governance**. The **Budgets** section lists your budgets, or reads **No budgets yet**.

</Step>

<Step title="Pick the scope">

In the form below the list, pick **agent**, **mission** or **team**. The list also offers **tenant**, but nothing charges a tenant budget, so it never warns or pauses.

</Step>

<Step title="Enter the id and the limit">

Type the id in **scope id**. Enter the limit in dollars in the next field, which reads **warn at $** (or **cap $** once you pick a hard cap). The smallest limit is $0.01.

</Step>

<Step title="Pick the mode">

Pick **warn only** (selected at first) or **hard cap**. See the next section for the difference.

</Step>

<Step title="Save it">

Press **Set budget**.

You should see a row with the scope and id, a **warn** or **cap** pill, the status **active**, the spend against the limit (for example `$0.00 / $5.00`) and a bar. The list refreshes every 5 seconds while the panel is open.

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

When an agent routine, a run started through the API, or an OpenClaw routine takes a budget past 80% or 100%, Clawboo also writes a `budget` entry to the audit log. Spend from team chat and one-to-one chat moves the bar and the status, but writes no audit entry.

## What a hard cap stops

A paused hard cap does not stop every kind of work at once. It depends on where the work runs:

| Where the work runs                                                         | Before a run starts                   | While a run is going                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team chat: General, rooms, team routines, Board tasks and hand-offs         | Not checked, so new turns still start | A Clawboo Native run on a priced model stops after its next model turn. Every other run is charged when it ends, so it finishes                                                                                                                                 |
| Agent routines and API runs on Clawboo Native, Claude Code, Codex or Hermes | The run is refused                    | Clawboo Native stops after its next model turn. Claude Code and Codex report their cost only as the run ends, so their work is already done; the run is still recorded as stopped by the cap, and the next run is refused. Hermes records no cost on these runs |
| OpenClaw agent routines                                                     | The run is refused                    | The run finishes. If it succeeds, its estimate is charged at the end and the next run is refused                                                                                                                                                                |
| One-to-one chat with a Clawboo Native agent                                 | Not checked                           | A run on a priced model stops after its next model turn                                                                                                                                                                                                         |

What you see when a hard cap stops work:

- **A run started through the API** that a cap stops is cancelled, and its task goes back to **To do** with the comment `Auto-paused: <scope> budget reached. Raise the cap (or resume) to continue.` A run refused before it starts answers `422` with the reason `budget_paused` and leaves the task as it was.
- **An agent routine** counts the refused or stopped run as a failure. The routine stops until you resume it, and its task waits in **Needs you**; see [When a routine stops](/using/routines#when-a-routine-stops).
- **An OpenClaw routine** whose estimate crosses the cap leaves the comment `Budget cap reached (<scope>). This run is recorded; the next scheduled fire is blocked until you raise the cap or resume.`
- **Team chat**: a stopped run that had not replied yet leaves the message `The run failed: the run was stopped by a budget cap`, and a handed-off task it was working on waits in **Needs you**.

To halt a team that keeps working past its budget, press **Stop** in its chat. [What a hard cap stops](/concepts/governance#what-a-hard-cap-stops) has the full rules.

## Resume or raise a budget

A paused budget shows a **Resume** button on its row.

- **Resume** puts the budget back to **active** at once, without changing the limit. If spend is still at or over the limit, a message warns you and the row shows **will re-pause**: the next recorded spend pauses it again.
- **Set cap** changes the limit. Type the new amount in the row's **new cap $** field and press **Set cap**. It keeps the row's mode. A limit above the current spend un-pauses the budget: it reads **active** again, or **soft_capped** while spend is still 80% of the new limit or more.

To give a paused budget room, use **Set cap** with a higher limit. Then restart what it stopped, for example with **Retry** on its task in **Needs you**, or **Resume** on the routine under **Settings** > **Workspace** > **Routines**.

<Warning>

**Saving a budget from the form sets its mode again.** The form starts on **warn only**, so pressing **Set budget** for a scope that already has a hard cap turns it into warn only, with no message. A `POST /api/governance/budgets` without `"mode": "cap"` does the same. To raise a hard cap, use **Set cap** on its row. To turn a warn-only budget into a hard cap, save it from the form with **hard cap** picked.

</Warning>

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

In the form, pick the same scope and id, enter the limit you want, pick **hard cap**, and press **Set budget**. The spend so far is kept, so if it is already at or over the new limit, the budget pauses at once.

You should see the **cap** pill on the row.

</Step>

</Steps>

## Read the audit log

The **Audit log** at the bottom of **Governance** keeps a record of what Clawboo's guardrails did, newest first, up to 200 entries at a time. Each entry shows the time of day, the event type, the start of the agent's id and a one-line summary. Narrow it with the **agent id** box (the full id), the event type list and **All**, **1h**, **24h** or **7d**. It reloads when you change a filter or press **Refresh** at the top of the panel.

The event types that matter for spend:

| Event type      | What it records                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `budget`        | A budget passing 80% or 100% on an agent routine, an API run or an OpenClaw routine, and each run a hard cap auto-paused |
| `cap_hit`       | A team-chat turn that tried to start more hand-offs than the fan-out cap allows                                          |
| `circuit_break` | A circuit breaker stopping an agent routine or API run that was going nowhere                                            |
| `approval`      | Decisions on risky hand-offs, and unanswered approvals that Clawboo's cleanup expired                                    |

Resuming a budget writes no entry, and neither does spend in team chat or one-to-one chat.

## The rest of the Governance panel

- **Caps (enforced in code)** shows three chips you cannot change. **max spawn depth** 2 means a task can have at most two tasks above it, so a chain of hand-offs is three tasks deep. **max fan-out** 8 is the most hand-offs one team-chat turn can start. **per-node cost** names a per-run cost limit that only a routine set up through the API can carry; the chip is not a limit in force. [Budgets and guardrails](/concepts/governance#caps-on-delegation-and-task-creation) explains each one.
- **Approval queue** lists every pending approval from every team. See [Approvals](/using/approvals).

## Troubleshooting

<AccordionGroup>

<Accordion title="My budget passed 100% and nothing stopped">

A **warn only** budget never pauses anything; switch it to **hard cap** (see the Warning above). A hard cap in team chat stops only Clawboo Native runs on a priced model. Other team-chat runs finish, and their cost is charged when they end. See [What a hard cap stops](#what-a-hard-cap-stops).

</Accordion>

<Accordion title="The budget is paused, but the team still runs">

Team chat does not check budgets before a turn starts, so new messages still start runs. Press **Stop** in the team's chat to end what is running, and hold back new work until you raise the limit.

</Accordion>

<Accordion title="I resumed a budget and it paused again at once">

Spend is still at or over the limit, which the **will re-pause** pill on the row tells you. Raise the limit with **Set cap**, then resume what it stopped.

</Accordion>

<Accordion title="My hard cap turned into warn only">

The budget was saved again from the form, which starts on **warn only**. Pick the same scope and id in the form, pick **hard cap**, and press **Set budget**. Use **Set cap** on the row whenever you only want a new limit.

</Accordion>

<Accordion title="Set budget did nothing">

With an empty **scope id**, or a limit that is not a number, the button does nothing. With a limit of $0, Clawboo refuses the budget and the form clears without a message. Enter a limit of at least $0.01.

</Accordion>

<Accordion title="The budget's bar never moves">

Check the id: Clawboo accepts any id, so a budget for a mistyped one is never charged. A **tenant** budget is never charged either. A budget also counts only spend after it was created, and some work charges no budget at all: Hermes routine and API runs, OpenClaw routine runs that fail, one-to-one chat with an OpenClaw agent, and one-to-one chat with a Clawboo Native agent on a model that is not priced.

</Accordion>

<Accordion title="Couldn't load budgets.">

The panel could not read the budget list from Clawboo's server. Press **Retry** in the alert. If the alert stays, check that Clawboo is still running.

</Accordion>

<Accordion title="Tokens Used shows zero for my agents">

**Tokens Used** counts OpenClaw agents only. For Clawboo Native, Claude Code, Codex and Hermes agents, read the cost on each task's card on the Board, or set a budget.

</Accordion>

<Accordion title="A local Ollama run shows a cost">

Clawboo has no price for local models, so it estimates Ollama runs at the default rate of $3 per million input tokens and $15 per million output tokens, and marks them **est.** Your real cost is zero; treat the figure as a placeholder.

</Accordion>

<Accordion title="The bar is amber, but the audit log shows no warning">

Spend from team chat and one-to-one chat updates the budget's bar and status without writing an audit entry. Warnings appear in the log only for agent routines, API runs and OpenClaw routines.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- **Statuses and modes.** Budgets are stored with the modes `warn` and `cap` and the statuses `active`, `soft_capped` and `paused`. A `warn` budget never reads `paused`. Spend is kept in fractions of a cent, so many tiny costs add up, and each scope (agent, mission, team) is updated in its own write.
- **Budgets over REST.** `GET /api/governance/budgets` lists them. `POST /api/governance/budgets` takes `{ "scope", "scopeId", "limitUsdCents", "mode" }`, where `limitUsdCents` is a positive whole number and a missing `mode` means `warn`; saving an existing scope updates its limit and mode. `POST /api/governance/budgets/:scope/:scopeId/resume` resumes a budget and answers `willRepause`; when spend is at or over the limit, an optional `graceUsdCents` raises the limit to the current spend plus the grace and keeps the mode. There is no delete route.
- **The audit log over REST.** `GET /api/governance/audit` takes `agentId`, `eventType`, `since` and `limit` (at most 1,000).
- **Another way to get a hard cap.** Creating a Clawboo Native agent through the API with `budgetUsd` also creates a hard-cap budget for that agent.
- **Run costs.** Each run records its cost with a source of `reported`, `token-estimate` or `char-estimate`. A task's total reads as an estimate when any of its runs is not `reported`.
- **Tokens Used** reads `GET /api/cost-records/summary`. Clawboo's server writes one cost record for each OpenClaw turn it can match to an agent in Clawboo.
- Shapes and codes: [Governance API](/reference/rest-api/governance) and [Costs and fleet API](/reference/rest-api/costs).

</Accordion>

## Next steps

- [Budgets and guardrails](/concepts/governance): the model behind budgets, caps and circuit breakers, path by path.
- [Approvals](/using/approvals): answer the requests in the **Approval queue**.
- [Routines](/using/routines): resume a routine that a hard cap stopped.
- [Board](/using/board): read what each task cost.
- [Limits and defaults](/reference/limits-and-defaults): every threshold and waiting time in one place.
