---
title: 'Observability'
sidebarTitle: 'Observability'
description: 'What Clawboo records about the work your agents do, where to see it in the app, what traces cover, and what OpenTelemetry export needs.'
icon: 'activity'
keywords:
  [
    'event log',
    'activity',
    'traces',
    'fleet health',
    'harness bug',
    'error taxonomy',
    'OpenTelemetry',
    'OTLP',
    'Jaeger',
  ]
---

Clawboo records what your agents do in an event log kept in its own database: tasks moving on the board, runs starting and ending, tool calls and their results, errors, costs and routine runs. The **Activity** views, the **Observability** panel, the **Fleet** panel's recent issues and the live status on a team's graph are all built from this log. The log stays on your machine. Clawboo sends no telemetry, and sending traces to a tool of your own takes extra setup (see [OpenTelemetry export](#opentelemetry-export)).

Use this page to learn what is recorded, where to look, and where the gaps are. A tour of the panels themselves is in [Observability](/using/observability).

## What gets recorded

Every event has a kind. There are 25:

| Group      | Kinds                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| Board      | `task_created`, `task_claimed`, `status_changed`, `comment_added`, `dep_linked` |
| Runs       | `execution_started`, `execution_completed`, `session_rotated`                   |
| Tools      | `tool_call`, `tool_result`                                                      |
| Cost       | `cost`                                                                          |
| Approvals  | `approval_requested`, `approval_resolved`                                       |
| Errors     | `error`                                                                         |
| Traces     | `span_start`, `span_end`                                                        |
| Routines   | `routine_fired`, `routine_dispatched`, `routine_completed`, `routine_error`     |
| Peer chat  | `team_chat_post`, `speaker_selected`, `turn_bound_hit`                          |
| Connectors | `grant_decision`, `connector_health`                                            |

How much each run records depends on how it started (see [How a team works](/intro/how-it-works) for the two paths):

- **Team chat** records board changes, runs, tool calls and errors. It writes no `cost` events and no trace spans.
- **The task runner** (agent routines on Clawboo Native, Claude Code, Codex and Hermes, and runs started through the API) records all of that, plus a `cost` event for each cost report and a trace for each run.
- **OpenClaw activity that Clawboo did not start**, such as an OpenClaw agent's own cron job or a message from another channel, is still recorded as tool calls and results while Clawboo is connected to the Gateway.

A connector's grant decision is its own event because a denied call never produces a tool call, so a denial would otherwise leave no trace. Event data is scrubbed of secrets before it is stored, and masked again when the app shows it.

## Where to look

| Where                                                     | What it shows                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Activity** card in a team chat, an agent page or a task | The live stream of events for that team, agent or task                                               |
| **Activity** dock on the Org chart                        | The same stream for every team                                                                       |
| **Team graph** card                                       | A live status dot on each Boo while it is working, stalled or a zombie (see below)                   |
| Settings > Insights > **Observability**                   | Fleet health, error classes and harness bugs, traces, the delegation graph, and **Run smoke evals**  |
| Settings > Insights > **Fleet**                           | Agents per runtime, task and verification pass rates and task spend over 24 hours, and recent issues |
| Settings > Insights > **Governance**, **Audit log**       | Budget warnings and pauses, approvals, breaker trips and cap hits, which go to a separate audit log  |
| Settings > System > **System Health**                     | Among other checks, whether the OpenTelemetry exporter started                                       |

**Fleet health** sorts each agent by its open run: **working** (an open run with a recent event), **idle** (no open run), **stalled** (no event for 5 minutes) or **zombie** (no event for 30 minutes, so the process is almost certainly gone).

## What traces cover

A trace groups one run's events into a timeline: the run itself, with each tool call inside it. Runs of tasks in the same delegation tree share one trace, keyed on the tree's top task.

Only runs the task runner starts have traces. Team-chat work and OpenClaw routines are recorded as events without a trace, so they never appear in the **Traces** list or in OpenTelemetry export. Most everyday work happens in team chat, so an empty **Traces** list is normal if that is how you use Clawboo.

## Errors and harness bugs

Clawboo sorts every error a run reports into a class, by keywords in its code and message. The first class that fits wins, in the order of this table:

| Class             | Typical cause                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `RateLimited`     | The provider is throttling you: 429, rate limit, quota, resource exhausted                   |
| `UserAborted`     | The run was stopped or cancelled                                                             |
| `Timeout`         | Something took too long: timeout, timed out, ETIMEDOUT, deadline exceeded                    |
| `UnexpectedEnv`   | A missing file or program, or a permission problem: ENOENT, EACCES, EPERM, command not found |
| `ContextOverflow` | The prompt was too long for the model                                                        |
| `InvalidArgs`     | The request was malformed: 400, 422, validation, missing required field                      |
| `ProviderError`   | The provider failed: 500, 502, 503, 504, upstream, overloaded, service unavailable           |
| `Unknown`         | Nothing matched                                                                              |
| `PolicyDenied`    | A guardrail refused a tool call. Task-runner runs only, checked before every other class     |

An `Unknown` error is flagged as a **harness bug**: most likely a defect in Clawboo rather than in your prompt or your provider. If you see one, please [open an issue](https://github.com/clawboo/clawboo/issues) with the error text. A `PolicyDenied` error is never a harness bug; it means a guardrail did its job.

## How much the views read, and how long the log keeps

- Fleet health and the delegation graph read the newest 5,000 events, so older agents and tasks drop out of them. A single trace shows at most 5,000 events. The error list shows the newest 500 errors, and its harness-bug count covers only those.
- Nothing prunes the event log or the tool-call audit, so both grow as you use Clawboo. Stored tool results are the exception: they are deleted after 7 days (`CLAWBOO_TOOL_RESULT_TTL_MS`). To back up or reset your data, see [Data and state](/operating/data-and-state).

## OpenTelemetry export

Clawboo can also send its traces to an OpenTelemetry collector, such as Jaeger or any OTLP endpoint. Export is off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) before you start Clawboo. `OTEL_SERVICE_NAME` sets the service name, `clawboo` by default. Only task-runner runs have traces, so only those are exported.

<Note>

**The npm package does not include the OpenTelemetry SDK.** On an install from npm (`npx clawboo@latest` or a global install), setting the endpoint exports nothing. The exporter cannot load, traces stay in the local log, and **System Health** shows the **OTel exporter** check as degraded. Its **observability** row still reads "OTel exporter active", because that row only reports that an endpoint is set. Export works where the two packages it needs, `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http`, can be loaded, as when you run Clawboo from a source checkout of the repository.

</Note>

<AccordionGroup>

<Accordion title="Under the hood">

- The log is the `orchestration_events` table in Clawboo's SQLite database. Each row has an auto-increment `seq` (the order of events, and the cursor for the live stream), a UUID `id`, a timestamp, the kind, team, task, agent and runtime ids, trace and span ids, and a scrubbed JSON `data` field. A row with an unknown kind is stored as `error`.
- The live stream is `GET /api/obs/stream`, a Server-Sent Events feed polled every 750 ms that resumes from `Last-Event-ID` or `?since=<seq>`. With no cursor it replays the scoped log from the start, then follows it.
- `POST /api/obs/ingest` accepts five kinds from outside the server: `tool_call`, `tool_result`, `error`, `grant_decision` and `connector_health`, at most 200 per batch. Board, cost and approval events are never accepted from outside.
- The MCP stdio servers write to this log only when they open the server's database. The attach configs Clawboo generates set `CLAWBOO_DB_PATH` so they do.
- Errors are classified on both paths. A refused tool call is recognized as `PolicyDenied` only in the task runner; in team chat the same refusal is classified by its message.

</Accordion>

</AccordionGroup>

## Related

- [Observability](/using/observability): a tour of the Observability and Fleet panels.
- [Budgets and guardrails](/concepts/governance): spend limits, circuit breakers and caps, and the audit log they write to.
- [Events and errors](/reference/events-and-errors): every event kind and error class in detail.
- [Observability API](/reference/rest-api/observability): read events, traces and the live stream over REST.
- [Environment variables](/reference/environment-variables): the OpenTelemetry and retention settings.
- [System Health](/using/system-health): the checks Clawboo runs at startup, including the OpenTelemetry exporter.
