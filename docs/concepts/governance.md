---
title: 'Budgets and guardrails'
sidebarTitle: 'Budgets and guardrails'
description: 'The limits Clawboo puts on spend, stuck runs and delegation: which are on by default, which you turn on, and which kinds of run each one covers.'
icon: 'shield-check'
keywords:
  [
    'governance',
    'budget',
    'hard cap',
    'warn only',
    'circuit breaker',
    'delegation depth',
    'fan-out',
    'delegation approval',
    'spend limit',
  ]
---

Clawboo puts limits on what your agents spend and on how far their work spreads. A few limits are always on. The one that stops spending, a budget in **hard cap** mode, is off until you create one. These guardrails narrow the damage a run that goes wrong can do. They cannot rule out a runaway agent, and most of them cover only some of the ways work runs.

Use this page to learn what each guardrail does and where it applies. To create, raise or resume a budget, see [Budgets and spend](/using/budgets-and-spend).

## Where work runs decides which guardrails apply

Work reaches your agents along two main paths. [How a team works](/intro/how-it-works) explains both.

- **Team chat.** Messages in General and rooms, the hand-offs they lead to, and the tasks you give an agent on the Board. Most work runs here.
- **The task runner.** Agent routines on Clawboo Native, Claude Code, Codex and Hermes, and runs started through the API with `POST /api/runtimes/:id/run`.

An agent routine on OpenClaw takes a third, smaller path: a dispatcher that sends the work over the OpenClaw Gateway and waits for the result. The guardrails differ by path:

| Guardrail                         | Default                  | Team chat                        | Task runner                     | OpenClaw agent routine |
| --------------------------------- | ------------------------ | -------------------------------- | ------------------------------- | ---------------------- |
| Spend counted against budgets     | On, once a budget exists | Yes                              | Yes                             | Yes                    |
| Budget warnings in the audit log  | On, once a budget exists | No                               | Yes                             | Yes                    |
| Hard cap refuses the next run     | Off until you set one    | No                               | Yes                             | Yes                    |
| Hard cap stops a run partway      | Off until you set one    | Clawboo Native on a priced model | Clawboo Native                  | No                     |
| Per-run cost cap                  | Off                      | No                               | Routines set up through the API | No                     |
| Circuit breakers                  | On                       | No                               | Yes                             | No                     |
| Delegation depth and fan-out caps | On                       | Yes                              | Depth only                      | No                     |
| Approval for risky delegations    | On                       | Yes                              | No                              | No                     |

One-to-one chat follows its own rules. A Clawboo Native agent's one-to-one chat charges only that agent's budget, and only for a priced model. One-to-one chat with an OpenClaw agent is not charged to any budget.

## Budgets

A **budget** is a dollar limit on one scope:

- **agent**: everything one agent spends.
- **mission**: one delegation tree, counted on its top task (the first task in the chain of hand-offs).
- **team**: everything a team's runs spend.

The scope list in the Governance panel also offers **tenant**. Nothing charges a tenant budget, so it never warns and never pauses.

Each budget has a mode:

- **warn only** (the default). Clawboo counts spend and never pauses anything. From 80% of the limit the budget reads **soft_capped**, and it stays there past 100%.
- **hard cap** (you opt in). Spend is counted the same way. At 100% the budget reads **paused**, and what that stops depends on the path (see the table above and [What a hard cap stops](#what-a-hard-cap-stops)).

Spend counts against a scope only after a budget exists for it. With no budget, nothing is measured against a limit, though costs still show where Clawboo reports them.

### How spend is measured

Not every runtime reports what a run cost. Claude Code reports a dollar figure. Clawboo Native works one out from token counts for six models it has list prices for: claude-haiku-4-5, claude-sonnet-4-6, gpt-4o, gpt-4o-mini, and the OpenRouter ids anthropic/claude-haiku-4.5 and openai/gpt-4o-mini. These are the **priced models**. The default leader models (claude-sonnet-5 on Anthropic, gpt-5.4 on OpenAI) are not on the list.

Everything else is an estimate: from token counts where the runtime reports them, or from the length of the text when it reports none. Estimates count toward budgets the same as reported figures. A Hermes run started by a routine or the API reports nothing, so no budget sees it. The cost table in [Budgets and spend](/using/budgets-and-spend) has the details for each runtime.

### What a hard cap stops

**In the task runner**, Clawboo checks the agent, mission and team budgets before a run starts and refuses the run if a hard cap among them is paused. During the run it counts each cost report and stops the run as soon as a hard cap pauses. Only Clawboo Native reports cost while it works, once per model turn. Claude Code and Codex report cost only as the run ends. If that report takes a hard cap to its limit, the work is already done, but Clawboo still records the run as auto-paused (cancelled), sends its task back to To do, and refuses the next run.

**In team chat**, nothing checks a budget before a turn starts. A Clawboo Native run on a priced model stops after its next model turn once a hard cap pauses. Every other run (Claude Code, Codex, Hermes, OpenClaw, and Clawboo Native on other models) is charged when it finishes. The budget then reads paused, but the next team-chat turn still runs. To halt a team that is over its budget, press **Stop** in the chat.

**For an OpenClaw agent routine**, a paused hard cap refuses the fire before it starts. OpenClaw reports no cost while it works, so Clawboo estimates the run from its text when it succeeds; a failed or timed-out run records no spend. If that estimate crosses the cap, the task gets the comment "Budget cap reached" and the routine's next fire is refused.

When a hard cap stops a task-runner run, the run is cancelled and the task goes back to To do with the comment "Auto-paused: `<scope>` budget reached. Raise the cap (or resume) to continue." If the run was a routine fire, the routine then stops until you resume it, and the task the fire created waits in **Needs you** (see [How routines run](/concepts/scheduling)). When a hard cap stops a team-chat run, its task fails.

### Resuming and raising a budget

**Resume** puts a paused budget back to active. If spend is still at or over the limit, the next cost report pauses it again, and the row shows a **will re-pause** pill. To make room, raise the limit with **Set cap** on the budget's row.

<Warning>

**Saving a budget again can turn a hard cap into warn only.** The mode is set on every save. Saving the same scope from the create form with **warn only** selected (the form's default), or sending `POST /api/governance/budgets` without `"mode": "cap"`, switches the budget to warn only. To raise a hard cap's limit, use **Set cap** on its row, which keeps the mode.

</Warning>

There is one more way a hard cap appears: creating a Clawboo Native agent through the API with a `budgetUsd` value also creates a hard-cap budget for that agent.

### The per-run cost cap

A routine created through the API can carry a per-run cost cap (`maxNodeCents` in its task template). The task runner stops that routine's run once the run itself has cost that much, the same way a paused hard cap would. Nothing else sets it, and it is off by default. The Governance panel shows a **per-node cost** chip with the value **per-run**: that chip names the feature, it is not a limit in force.

## Circuit breakers

Circuit breakers stop a task-runner run that is going nowhere, before a budget would. They are always on in the task runner. They do not run in team chat or for OpenClaw routines.

| Breaker        | Trips when                                                                  | Default                    |
| -------------- | --------------------------------------------------------------------------- | -------------------------- |
| Iteration cap  | A run makes more tool calls than the limit                                  | More than 30               |
| Repeat failure | The same tool call, with the same input, keeps failing                      | 3 times in a row           |
| No progress    | Tool results in a row add no new successful output                          | 6 in a row                 |
| Token velocity | The run uses tokens faster than the limit, measured over 15 seconds or more | More than 200,000 a minute |
| Repeat denial  | The same policy refusal comes back                                          | 2 times in a row           |

A successful call that repeats an earlier one counts as neither progress nor failure, so an agent that re-reads a file is not penalized. Token velocity needs at least two cost reports in one run, so in practice it can trip only on Clawboo Native.

When a breaker trips, the run is cancelled, the task gets a comment that starts `[stopped: <reason>]`, and the task goes back to To do. For a routine fire, the routine then stops and its task waits in **Needs you**, as with a hard cap. A worktree, if the run had one, is kept. Each trip is written to the audit log as a `circuit_break` event. A run started through the API can tune the limits with a `breakerConfig` object.

## Caps on delegation and task creation

These caps are always on. Clawboo enforces them in code, whatever the model asks for.

- **Depth.** A chain of hand-offs can be three tasks deep. The leader hands off the first task, and the agents on the next two levels can each hand off once more. The agent on a third-level task cannot delegate: it is told to do the work itself or report back. The Governance panel shows this as **max spawn depth** 2, meaning a task can have at most two tasks above it. The same limit applies to multi-step plans and to subtasks agents file through Clawboo's Tasks tools, and the task runner refuses a task that sits deeper.
- **Fan-out.** One team-chat turn can start at most 8 hand-offs at once (the steps of a multi-step plan are not counted). The rest are not started, the leader is told how many were dropped, and the audit log records a `cap_hit` event.
- **Repeated failures.** After the same task fails 3 times in a row with the same teammate, the leader cannot hand it to that teammate again. It is told to do the work itself, give it to someone else, or tell you it cannot be done. The count resets when the Clawboo server restarts.
- **Children.** When an agent files subtasks itself through Clawboo's Tasks tools, one parent task can have at most 24 child tasks. Deleting a child frees a slot. Finished and cancelled children still count.
- **New top-level tasks.** The Tasks tools refuse to create a top-level task once 30 were created in the last 5 minutes, counting tasks from every source.

Tasks you create on the Board are never refused by these caps, though they count toward the 5-minute total.

## Approval for risky delegations

When an agent in team chat hands off a task whose text contains a risky word, Clawboo asks you before the hand-off happens. The approval appears with your other pending approvals, for example in the Governance panel's **Approval queue** (see [Approvals](/using/approvals)).

The check is a plain match on whole words, in any letter case:

- delete, destroy, deploy, publish, release, secret, credential, prod, production
- the phrases drop table and rm -rf
- api_key, api-key or apikey, and force-push, force_push or forcepush

Because it matches whole words only, "deleted", "deployment" or "secrets" do not trigger it, and neither do "API key" or "force push" written with a space. The steps of a multi-step plan are not checked at all. Treat the check as a speed bump, not a review of what the task does.

The request waits up to 5 minutes. If you allow it, the hand-off goes ahead. If you choose **Don't allow**, or nobody answers in time, the hand-off is skipped and the agent that handed it off is told it was not approved. If Clawboo cannot record the request, the hand-off is skipped too.

The approval card in the dashboard offers only a one-time allow and **Don't allow**. An approval resolved as `allow_always` through the API (`POST /api/tools/approvals/:id/resolve`) is permanent: Clawboo stops asking about that leader's risky hand-offs, with no expiry, and the dashboard has no control to take it back. When you have Boo Zero, it leads every team, so one such answer covers all of them.

## Running commands and using apps

Separate approvals decide whether an agent may run a shell command or act in a connected app without asking you:

- An OpenClaw agent's **Command Execution** setting (new OpenClaw agents start at **Ask for Unknown**). See [Command permissions](/using/command-permissions).
- A Clawboo Native agent's **Let this Boo ask to run commands** switch, off by default. When it is on, the agent asks before every command, and a run can ask at most 10 times. Commands are offered only on task-runner runs in a worktree, never in team chat or one-to-one chat, and never on Windows.
- Approvals for actions in connected apps. See [Approvals](/using/approvals).

Claude Code, Codex and Hermes run with their own approval prompts turned off, so Clawboo does not ask before their commands. [What agents can do](/concepts/permissions) explains what that means for your files.

## What these guardrails do not cover

- **What a run can touch.** Budgets, breakers and caps limit spend and effort. A run that stays under its budget can still read and change anything its runtime can reach. See [What agents can do](/concepts/permissions).
- **Stuck runs in team chat.** Team chat has no circuit breakers. Besides the delegation caps, its guard against a stuck run is time. A handed-off task whose run reports nothing for 8 minutes is failed (24 minutes while the agent is inside one tool call), and any run silent for 30 minutes is ended. The task runner ends a run after the same 30 minutes of silence.
- **Warnings from team-chat spend.** Spend from team chat moves a budget's bar and status in the Governance panel, but no warning event is written to the audit log.
- **Expensive but healthy runs.** The breakers are tuned so a healthy run never trips them, so a costly run that keeps making progress passes them. A hard-cap budget is the only limit set in dollars, and it holds only as far as [What a hard cap stops](#what-a-hard-cap-stops) describes.

<AccordionGroup>

<Accordion title="Under the hood">

- Budget statuses are `active`, `soft_capped` (from 80%) and `paused` (a hard cap at 100%). A warn-only budget never reads `paused`. The modes are stored as `warn` and `cap`, and spend is kept in fractions of a cent so tiny costs add up.
- Each recorded amount is charged to every scope that has a budget: the agent, the team and, when the run works a task, the mission. Each scope is updated in its own write.
- The audit log's event types are `budget` (warnings and auto-pauses), `circuit_break`, `cap_hit`, `approval`, `verification`, `tool_call` and `install`.
- A risky-delegation approval is a row in the tool-call approvals table with the scope key `delegate:code`. A past `allow_always` row for the same leader and key skips the prompt.
- Budgets over REST: `GET` and `POST /api/governance/budgets`, `POST /api/governance/budgets/:scope/:scopeId/resume` (an optional `graceUsdCents` raises the limit to current spend plus the grace and keeps the mode) and `GET /api/governance/audit`. See the [Governance API](/reference/rest-api/governance).
- The run loop that applies budgets and breakers is described in [Executor runner](/internals/executor-runner).

</Accordion>

</AccordionGroup>

## Related

- [Budgets and spend](/using/budgets-and-spend): create, raise and resume budgets, see where spend shows, and read the cost table.
- [What agents can do](/concepts/permissions): what a run can touch, which these limits do not bound.
- [How routines run](/concepts/scheduling): what a refused or stopped run does to a routine.
- [Approvals](/using/approvals): where pending approvals appear and how to answer them.
- [Governance API](/reference/rest-api/governance): budgets, the audit log and delegation approval over REST.
- [Limits and defaults](/reference/limits-and-defaults): every number on this page in one place.
