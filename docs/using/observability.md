---
title: 'Check on your agents'
sidebarTitle: 'Fleet and observability'
description: 'Use the Fleet and Observability panels and the Activity feeds to see how your agents are doing, what they did and what went wrong.'
icon: 'activity'
keywords:
  [
    'observability dashboard',
    'Observability',
    'Fleet',
    'fleet health',
    'activity feed',
    'traces',
    'error taxonomy',
    'harness bug',
    'smoke evals',
    'OpenTelemetry',
    'OTLP',
  ]
---

Use this page to check how your agents are doing, find out what one of them did, and see what went wrong. These views read what Clawboo records in its own database on your computer: tasks moving on the board, runs starting and ending, tool calls, costs and errors. [Observability](/concepts/observability) explains what is recorded and where the gaps are.

## Where to look

| You want to                                | Open                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| See every runtime and agent at a glance    | **Settings** > **Fleet**                                                                                              |
| Find out what an agent did on a task       | The task's card on the **Board**, or the task in a team chat's **Tasks** card                                         |
| Watch one agent work                       | The **Activity** card on the agent's page                                                                             |
| Watch a whole team                         | The **Activity** card beside the team's chat                                                                          |
| Watch every team at once                   | **Activity**, the terminal icon in the **Org chart**'s header                                                         |
| Find errors, stuck agents and run traces   | **Settings** > **Observability**                                                                                      |
| See budget warnings, pauses and approvals  | **Settings** > **Insights** > **Governance**, under **Audit log** (see [Budgets and spend](/using/budgets-and-spend)) |
| Check that Clawboo's own parts are working | **Settings** > **System Health** (see [System Health](/using/system-health))                                          |

To open **Settings**, click **Settings** at the bottom of the left sidebar, or press Cmd+, (macOS) or Ctrl+, (Windows, Linux) while no text field has focus. **Fleet** and **Observability** are in the **Insights** group.

## Check the fleet

**Fleet** fits your whole setup on one screen: how many agents you have, how the last day of board work went, what it cost, and whether each runtime is ready.

![The Fleet view in Settings: the Agents, Task pass-rate, Verify pass-rate and Spend cards above a tile for each runtime, with a health dot, a badge and healthy, degraded and down counts](/images/fleet-health.png)

| Part                       | What it shows                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents**                 | Every agent that is not archived, on any runtime                                                                                                                                                                                            |
| **Task pass-rate · 24h**   | Of the board tasks updated in the last 24 hours that ended **Done** or **Cancelled**, the share that ended **Done**. Below it: how many are done and how many are still active                                                              |
| **Verify pass-rate · 24h** | Of the verification results on board tasks updated in the last 24 hours, the share that passed, and how many results there were. Most work is never checked, so this often shows a dash (see [How work is checked](/concepts/verification)) |
| **Spend · 24h**            | The cost recorded on board tasks updated in the last 24 hours, and your number of budgets (or how many are paused). Some runtimes' costs are estimates (see [Budgets and spend](/using/budgets-and-spend))                                  |
| **Runtimes**               | A tile for each runtime (see below)                                                                                                                                                                                                         |
| **Recent issues**          | The six newest errors, each with its class, runtime and time. **All clear** means there are none                                                                                                                                            |

Every runtime gets a tile, even one with no agents. The dot beside its name is green when the runtime is ready and red when it is not:

- **Claude Code**, **Codex** and **Hermes**: green when the runtime's program is installed. It does not tell you whether the runtime is signed in or has a key.
- **Clawboo Native**: green when it has a provider it can use, such as an API key or a local Ollama.
- **OpenClaw**: green while Clawboo is connected to the OpenClaw Gateway.

The badge under the name says how Clawboo drives the runtime: **Native peer** (Clawboo Native runs inside Clawboo), **Wrapped one-shot** (Clawboo starts the runtime's program to do each piece of work) or **Connected substrate** (OpenClaw, a separate Gateway that Clawboo connects to). The chips count the runtime's agents by state: **healthy** (idle or working), **degraded** (in an error state) and **down** (any other state, such as asleep).

Fleet refreshes every 8 seconds while its tab is visible. **Refresh** reloads it at once.

## Find out what an agent did

<Steps>

<Step title="Open the task">

On the **Board**, click the task's card to open its drawer. In a team chat, you can also open the **Tasks** card and click the task there.

</Step>

<Step title="Read the report">

The drawer shows what the agent reported, titled with its name (for example **Rin's report**). In a chat's **Tasks** card, the same text is under **Output** or **Latest report**.

</Step>

<Step title="Check each run">

The drawer's **Run history** lists every run of the task: the runtime, how it ended, when it started, what it cost and how many tokens it used, and the error if it failed.

</Step>

<Step title="Follow the activity">

**Activity** in the drawer (**Progress** in a chat's **Tasks** card) lists the task's events in order: each tool the agent called, what came back, and every error.

</Step>

</Steps>

You should now know what the agent did, what it cost and where it went wrong. [Track work on the board](/using/board) covers the rest of the drawer, retries and steering.

### Read an Activity feed

The same live feed appears in several places. On a task it covers that task. On an agent's page it covers that agent. Beside a team chat it covers the whole team, even in a room. The Org chart's **Activity** dock covers every team.

| Badge                    | What happened                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| **tool**                 | The agent called a tool. The row shows the tool and what the agent sent it                  |
| **result**               | What the tool returned. A red badge means the call failed                                   |
| **error**                | A run or a tool reported an error                                                           |
| **run**                  | A run started, or ended with its outcome                                                    |
| **status**               | The task moved to another status                                                            |
| **task**, **claim**      | A task was created; an agent took it                                                        |
| **note**                 | A comment was added to the task                                                             |
| **cost**                 | A run reported its cost and tokens. Runs in team chat report their cost on the task instead |
| **approval**             | Someone was asked to approve something, and the answer                                      |
| **grant**, **connector** | A connector call was allowed, denied or held for approval; a connector's health changed     |

A feed that spans several agents names the agent on each row. Long tool input folds behind a toggle. The pill in the corner reads **Live** while new events stream in, and **Reconnecting** if the connection drops. The feed follows new rows while you stay at the bottom.

Activity from every runtime lands in the same log. That includes OpenClaw agents' own work that Clawboo did not start, such as a cron job or a message from another channel, while Clawboo is connected to the Gateway.

![The Org chart with its Activity dock open on the right: run, cost, note, status, tool and result rows from every team, with a Live pill](/images/activity-feed.png)

## Read the Observability panel

Open **Settings** > **Observability**. The left column holds **Fleet health**, **Error taxonomy** and **Traces**. The right column holds the **Eval scorecard**, the trace you select, and the **Delegation graph**. The header counts the tasks and agents in recent events. The panel refreshes every 5 seconds while its tab is visible, and **Refresh** reloads it at once.

### Fleet health

Each agent that appears in recent events gets a row with a status, how many runs it has open, and the cost its runs reported to the log. Rows show the agent's id (its first 12 characters), not its name.

| Status      | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| **working** | A run is open and something happened in the last 5 minutes |
| **stalled** | A run is open, but nothing has happened for 5 minutes      |
| **zombie**  | A run is open, but nothing has happened for 30 minutes     |
| **idle**    | No run is open                                             |

A long model call can be quiet for minutes, so **stalled** on its own is not a failure. Team-chat runs report their cost on the task, so their agents show $0.000 here; see the task on the board for what they cost.

### Error taxonomy

Clawboo sorts each error into a class, such as **RateLimited** or **ProviderError**. This section groups the newest 500 errors by class, most frequent first. Its title counts the classes and the harness bugs among them.

An error that fits no class is **Unknown** and carries a **harness bug** label: most likely a gap in Clawboo's own error handling rather than a problem with your prompt or provider. In team chat, a tool call that a guardrail refused can also land here, so read the message first. If it is not a refusal, [open an issue](https://github.com/clawboo/clawboo/issues) with the error text. [What to do about an error](#what-to-do-about-an-error) covers the other classes.

### Traces

A trace is one run's events laid out as a timeline: the run itself, with each tool call inside it.

Click a trace in the list to open it. A bar above the timeline totals the run:

| Figure       | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| **cost**     | What the run cost, in US dollars                         |
| **tokens**   | Input tokens, then output tokens                         |
| **tok/min**  | Output tokens per minute                                 |
| **tools**    | How many tool calls the run made                         |
| **tool err** | The share of tool calls that failed, amber when above 0% |

Only runs started by Clawboo's task runner have traces: a routine aimed at one agent on Clawboo Native, Claude Code, Codex or Hermes, and runs started through the API. Team chat, the tasks your team takes on from chat, team routines and OpenClaw work have no traces. Most everyday work happens in team chat, so an empty **Traces** list is normal. The list's empty message suggests running a board task, but a task your team runs from chat does not add one. [How a team works](/intro/how-it-works) explains the two paths.

### Delegation graph

When recent tasks were handed out or wait on each other, this section lists the links, one per row: the first task's id, an arrow, the second task's id, and the kind. **delegation** means the second task was handed out from the first. **dependency** links a task to another it waits on. The section is hidden when there are no links.

### Eval scorecard

**Run smoke evals** runs Clawboo's built-in test tasks on throwaway boards, with no AI model and no API keys, and never touches your own board. It shows how many test tasks passed (**pass@1** and **pass^k**) and a row for each one. If the run fails, the panel shows a short error; try again, and if it keeps failing, [open an issue](https://github.com/clawboo/clawboo/issues).

The **Ablation** table below it, marked **CI only**, is filled in only by the project's own test runs. In the app it shows the table's layout with no numbers.

<Accordion title="Under the hood">

- Fleet health and the delegation graph read the newest 5,000 events, so agents and tasks with older events drop out of them. A trace shows at most 5,000 events.
- The **Traces** list comes from the newest 300 events and shows up to 40 traces.
- The harness-bug count covers only the newest 500 errors.
- **Fleet** reads `GET /api/fleet/summary` and, for **Recent issues**, `GET /api/obs/errors`. The Observability panel reads `GET /api/obs/health`, `/api/obs/errors`, `/api/obs/events`, `/api/obs/graph` and `/api/obs/traces/:traceId`. See the [Observability API](/reference/rest-api/observability).
- **Run smoke evals** calls `POST /api/eval/smoke`. When it fails, the server log records only the failed request; the reason is in that call's JSON response.

</Accordion>

## What to do about an error

Each error's class tells you where to look. [Events and errors](/reference/events-and-errors) lists the words that put an error in each class.

| Class               | What it usually means                                   | What to do                                                                                                        |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **RateLimited**     | The provider is throttling you or you hit a quota       | Wait, then retry. If it keeps happening, check your plan's limits with the provider                               |
| **UserAborted**     | The run was stopped or cancelled                        | Nothing, unless nobody meant to stop it                                                                           |
| **Timeout**         | A model call, tool or program took too long             | Retry. If the same step keeps timing out, check the service it calls                                              |
| **UnexpectedEnv**   | A program or file is missing, or permission was refused | Check the runtime is installed in **Settings** > **Runtimes**, and that the files or folders the task needs exist |
| **ContextOverflow** | The conversation or input was too long for the model    | Start the chat fresh with `/reset`, or split the task into smaller ones                                           |
| **InvalidArgs**     | A request or tool call was malformed                    | Often the agent recovers on its own. If a task keeps failing this way, read the error text in its **Activity**    |
| **ProviderError**   | The provider failed or was overloaded                   | Retry later, and check the provider's status page                                                                 |
| **PolicyDenied**    | A guardrail refused a tool call (task-runner runs only) | Nothing: the guardrail did its job. Change the agent's permissions if the call should be allowed                  |
| **Unknown**         | Nothing matched: a **harness bug**                      | [Open an issue](https://github.com/clawboo/clawboo/issues) with the error text                                    |

## Export traces with OpenTelemetry

Clawboo can also send its traces to an OpenTelemetry collector, such as Jaeger. Export is off until you set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to the collector's OTLP over HTTP address, for example `http://localhost:4318`, in the environment that starts Clawboo's server. `OTEL_SERVICE_NAME` names the service, `clawboo` by default. Only runs with traces are exported, so team-chat work never reaches the collector.

<Note>

**The npm package does not include the OpenTelemetry SDK.** On an install from npm (`npx clawboo@latest` or a global install), setting the endpoint exports nothing: the exporter cannot load, and traces stay in Clawboo's own log. Export works where the two packages it needs, `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http`, are installed, as in a source checkout of the repository.

</Note>

To check whether export started, open **Settings** > **System Health** and read the **OTel exporter** check. "OTel exporter initialized" means it loaded. A **Degraded** check means it did not. Trust the check, not the **observability** row further down: that row reads **OTel exporter active** whenever an endpoint is set, even when the exporter failed to load.

## Troubleshooting

<AccordionGroup>

<Accordion title="The Observability panel is empty">

The Observability panel shows only what Clawboo has recorded, and a fresh install has recorded nothing yet. Give your team some work in [team chat](/using/team-chat) or on the [board](/using/board), then come back. **Fleet health**, **Error taxonomy** and the **Delegation graph** fill in from any work. **Traces** fill in only from task-runner runs (see [Traces](#traces)).

</Accordion>

<Accordion title="The Traces list is empty, but my team is busy">

This is expected. Work done in team chat, including the tasks your team takes on from chat, has no traces. Use the task's **Activity** on the board, or the **Activity** card beside the chat, to see what happened.

</Accordion>

<Accordion title="An agent reads stalled or zombie">

Open the agent's task on the board. If it is still **In progress** with nothing happening, the run may have hung: Clawboo puts a task whose run stops checking in back in **To do** after a few minutes, so it can run again. If the task has already moved on, the run's end never reached the log, and the agent can keep this status here until newer events push the old run out of view. The board is the one to trust.

</Accordion>

<Accordion title="The OTel exporter check is Degraded">

An OTLP endpoint is set, but the OpenTelemetry SDK could not load. On an npm install this is expected, because the package does not include the SDK. To clear the warning, unset `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and restart Clawboo. To export traces, run Clawboo from a source checkout.

</Accordion>

</AccordionGroup>

## Next steps

- [Observability](/concepts/observability): what the event log records, and where its gaps are.
- [Events and errors](/reference/events-and-errors): every event kind and error class in detail.
- [Track work on the board](/using/board): the task drawer, retries and steering.
- [Budgets and spend](/using/budgets-and-spend): where cost figures come from, and which are estimates.
- [System Health](/using/system-health): the checks Clawboo runs on its own parts.
- [Observability API](/reference/rest-api/observability): the same data over REST.
