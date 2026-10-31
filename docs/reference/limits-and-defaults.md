---
title: 'Limits and defaults'
description: 'Every built-in number in Clawboo: delegation caps, watchdogs, breakers, approval windows, rate limits, ports and timeouts, with the variable to change it and its source.'
keywords:
  ['limits', 'defaults', 'timeouts', 'caps', 'circuit breakers', 'rate limits', 'ports', 'watchdog']
---

This page lists every number Clawboo builds in that changes what you see: caps, timeouts, windows, retention and ports. Each row names the variable that changes it, if any, and the line of code that sets it, so maintainers can check it.

Some limits apply to only one of the two ways work runs. **Team chat** covers every chat turn, delegated task and team Routine. **Task runner** covers agent Routines on Clawboo Native, Claude Code, Codex and Hermes, and runs started with `POST /api/runtimes/:id/run`. [How a team works](/intro/how-it-works) explains both.

| Area                                              | What it covers                                                  |
| ------------------------------------------------- | --------------------------------------------------------------- |
| [Delegation](#delegation)                         | Depth, fan-out, subtask caps, watchdogs                         |
| [Runs and safety stops](#runs-and-safety-stops)   | Silence timeout, turn limit, context rotation, circuit breakers |
| [Verification](#verification)                     | Attempts, the check command, when a reviewer runs               |
| [Board and Routines](#board-and-routines)         | Heartbeats, stale tasks, auto-refire, worktree cleanup          |
| [What reaches an agent](#what-reaches-an-agent)   | Catch-up, inbox digest, tool results, memory injection          |
| [Memory](#memory)                                 | Search limits, ranking, embedding checks                        |
| [Approvals and budgets](#approvals-and-budgets)   | Approval windows, remembered answers, budget warnings           |
| [Agent browsers](#agent-browsers)                 | Browsers at once, idle close, saved screenshots                 |
| [Network and HTTP](#network-and-http)             | Ports, rate limits, request sizes                               |
| [Server and CLI](#server-and-cli)                 | Start, stop, logs, health checks, the database                  |
| [Updates and monitoring](#updates-and-monitoring) | Catalog and update checks, Fleet health thresholds              |

## Delegation

| Limit                                                                                | Value            | Change it | Source                                                        |
| ------------------------------------------------------------------------------------ | ---------------- | --------- | ------------------------------------------------------------- |
| Delegation depth: a task with this many parent tasks cannot delegate or get subtasks | 2                | No        | `packages/governance/src/caps/predicates.ts:12`               |
| Delegations one turn can start (team chat); the rest are skipped with a note         | 8                | No        | `apps/web/server/lib/teamChat/teamOrchestrator.ts:56`         |
| Subtasks under one parent task, finished ones included (Tasks MCP)                   | 24               | No        | `packages/governance/src/caps/predicates.ts:19`               |
| New top-level tasks an agent can create (Tasks MCP)                                  | 30 per 5 minutes | No        | `packages/governance/src/caps/predicates.ts:28-29`            |
| Failures in a row of the same agent on the same task before re-delegation is refused | 3                | No        | `packages/team-orchestration/src/boardOrchestration.ts:104`   |
| Silence before a delegated task is failed and the leader told (team chat)            | 8 minutes        | No        | `packages/team-orchestration/src/boardOrchestration.ts:62`    |
| The same, while inside one tool call or waiting to start                             | 24 minutes       | No        | `packages/team-orchestration/src/boardOrchestration.ts:89,96` |
| How often that watchdog checks                                                       | 30 seconds       | No        | `apps/web/server/lib/teamChat/teamOrchestrator.ts:57`         |
| Window for batching task updates to the leader                                       | 3 seconds        | No        | `packages/team-orchestration/src/boardOrchestration.ts:52`    |

The board's own REST API (`POST /api/board`) is not subject to the Tasks MCP caps. [Governance](/concepts/governance) explains the caps and when each applies.

## Runs and safety stops

| Limit                                                                                     | Value                                          | Change it                                                | Source                                            |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Silence before a run is stopped (team chat, task runner, one-to-one chat)                 | 30 minutes, then 5 seconds for it to wind down | `CLAWBOO_RUN_SILENT_TIMEOUT_MS`                          | `packages/executor/src/idleTimeout.ts:18,22`      |
| Wait for the same agent's previous run to finish                                          | 10 minutes                                     | `CLAWBOO_HOME_MUTEX_ACQUIRE_MS`                          | `apps/web/server/lib/executorRunner.ts:142`       |
| Model turns per Clawboo Native run (one model call plus its tool calls each)              | 16                                             | Per agent config, not in the dashboard                   | `packages/adapters/native/src/agentConfig.ts:97`  |
| Context rotation: start a fresh session at this share of the context window (task runner) | 85%                                            | No                                                       | `packages/executor/src/session-rotation.ts:147`   |
| Rotations per task (task runner)                                                          | 3                                              | Per run (`maxRotations` on `POST /api/runtimes/:id/run`) | `packages/executor/src/session-rotation.ts:148`   |
| Breaker: tool calls in one run (task runner)                                              | Stops past 30                                  | Per run (`breakerConfig`)                                | `packages/governance/src/breaker/policy.ts:30`    |
| Breaker: the same tool call failing with the same input, in a row                         | 3                                              | Per run (`breakerConfig`)                                | `packages/governance/src/breaker/policy.ts:31`    |
| Breaker: tool results in a row that add no new output                                     | 6                                              | Per run (`breakerConfig`)                                | `packages/governance/src/breaker/policy.ts:32`    |
| Breaker: token rate, measured once the run spans 15 seconds                               | Over 200,000 tokens per minute                 | Per run (`breakerConfig`)                                | `packages/governance/src/breaker/policy.ts:33-34` |
| Breaker: the same policy denial in a row                                                  | 2                                              | Per run (`breakerConfig`)                                | `packages/governance/src/breaker/policy.ts:35`    |

Circuit breakers, context rotation and the per-run settings exist only on the task runner. Team chat runs have the silence timeout, the delegation watchdog and, on Clawboo Native, the turn limit.

## Verification

Checks run only for task-runner work in a git worktree with changes; [How work is checked](/concepts/verification) explains when.

| Limit                                                | Value                                                       | Change it                | Source                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| Attempts before a failing task goes to **Needs you** | 2 (one fix cycle)                                           | `CLAWBOO_MAX_FIX_CYCLES` | `apps/web/server/lib/verification/index.ts:101`            |
| Time limit for the verify command                    | 10 minutes                                                  | No                       | `apps/web/server/lib/verification/deterministicGate.ts:25` |
| Command output kept as evidence                      | The last 4,000 characters                                   | No                       | `apps/web/server/lib/verification/deterministicGate.ts:26` |
| A reviewer also checks the work when                 | It was delegated, or changes over 5 files or over 300 lines | No                       | `packages/governance/src/verify/criticTrigger.ts:21-30`    |

## Board and Routines

| Limit                                                                          | Value                                        | Change it                                 | Source                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Heartbeat from a running task                                                  | Every 30 seconds                             | No                                        | `packages/db/src/board/repository.ts:427`             |
| Missed heartbeats before an **In progress** task returns to **To do**          | 3 minutes                                    | `CLAWBOO_BOARD_STALE_TTL_MS`              | `apps/web/server/index.ts:526`                        |
| How often that check runs                                                      | Every minute, and once at startup            | `CLAWBOO_BOARD_STALE_SWEEP_MS`            | `apps/web/server/index.ts:527`                        |
| Waking delegated work that is ready to run                                     | 10 seconds after startup, then every minute  | `CLAWBOO_DISPATCH_PUMP_MS` (the interval) | `apps/web/server/index.ts:553,589`                    |
| Failed or timed-out runs in a row before a task stops being retried on its own | 3 (a Stop is never retried)                  | No                                        | `packages/board-core/src/dispatch.ts:33`              |
| Text of your comment passed to the agent working on the task                   | The first 1,000 characters                   | No                                        | `apps/web/server/lib/teamChat/taskSteer.ts:27`        |
| Replies to a waiting task that start one run between them                      | Sent within 15 seconds of each other         | No                                        | `apps/web/server/lib/teamChat/personReply.ts:53`      |
| Wait for a reply to reach a running task before it reads as queued             | 2.5 seconds                                  | No                                        | `apps/web/server/lib/teamChat/personReply.ts:81`      |
| Room name length                                                               | 80 characters                                | No                                        | `packages/db/src/board/rooms.ts:24`                   |
| Worktree cleanup at startup                                                    | Older than 72 hours, or beyond the newest 25 | No                                        | `packages/worktrees/src/lifecycle.ts:60-61`           |
| Time limit for each git command                                                | 60 seconds                                   | No                                        | `packages/worktrees/src/git.ts:16`                    |
| Routines: how far ahead the scheduler sleeps at most                           | 60 seconds                                   | No                                        | `apps/web/server/lib/routines/ticker.ts:32`           |
| Routines: wait for an OpenClaw agent's run                                     | 10 minutes                                   | `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS`     | `apps/web/server/lib/routines/openclawDispatch.ts:46` |

Cleanup commits a worktree's changes before removing it and keeps its branch.

## What reaches an agent

| Limit                                                  | Value                                                  | Change it                                        | Source                                              |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| Teammates' new peer-room posts added to a turn         | 4,000 characters, at most 800 per post                 | No                                               | `apps/web/server/lib/teamChat/peerCatchup.ts:25,27` |
| Inbox notices added to a turn                          | 4,000 characters, at most 400 per notice               | No                                               | `packages/db/src/inbox.ts:102,98`                   |
| Undelivered inbox notices kept                         | 30 days                                                | No                                               | `packages/db/src/inbox.ts:176`                      |
| One tool result in an agent's context                  | 16 KiB; the rest is cut and kept for the agent to read | No                                               | `packages/mcp/src/ceiling.ts:35`                    |
| Stored copy of a large tool result                     | Up to 8 MiB                                            | No                                               | `packages/db/src/tools/resultStore.ts:45`           |
| How long stored tool results are kept                  | 7 days                                                 | `CLAWBOO_TOOL_RESULT_TTL_MS`                     | `apps/web/server/lib/approvalReaper.ts:29`          |
| Memory facts added at the start of a run (task runner) | Top 5, within 1,500 characters                         | Per run (`disableMemoryAutoInject` turns it off) | `apps/web/server/lib/defaults.ts:53,56`             |
| Related facts added alongside them                     | Up to 2, at similarity 0.8 or more                     | No                                               | `apps/web/server/lib/memoryInjection.ts:81-82`      |

[What an agent sees](/concepts/agent-context) explains what goes into each turn.

## Memory

| Limit                                       | Value                                                                   | Change it                                         | Source                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Search results                              | 10 by default, at most 100                                              | Per search                                        | `packages/db/src/memory/store.ts:54`, `packages/mcp/src/memory/server.ts:183` |
| Facts per browse                            | At most 200                                                             | Per call                                          | `packages/mcp/src/memory/server.ts:205`                                       |
| Hybrid ranking                              | 0.6 meaning match plus 0.4 keyword match                                | No                                                | `packages/db/src/memory/store.ts:588`                                         |
| Half-life of feedback on a fact             | 30 days                                                                 | No                                                | `packages/db/src/memory/learning.ts:44`                                       |
| Re-check of the embedding provider          | Every 10 minutes while a local Ollama works, every 30 seconds otherwise | `CLAWBOO_DISABLE_EMBEDDINGS` turns embeddings off | `apps/web/server/lib/memoryEmbedding.ts:49,53`                                |
| Filling in facts that have no embedding yet | Every 5 minutes (10 checks, 30 seconds apart)                           | No                                                | `apps/web/server/lib/memoryEmbedding.ts:57-58`                                |
| Re-check in the memory stdio bin            | Every 60 seconds                                                        | No                                                | `packages/mcp/src/memory/stdioEmbedSource.ts:30`                              |

## Approvals and budgets

| Limit                                                     | Value                                   | Change it                             | Source                                                      |
| --------------------------------------------------------- | --------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| Approval prompt for a tool call or a risky delegation     | 5 minutes, then it expires              | No                                    | `packages/db/src/tools/persistence.ts:27,34`                |
| **Always** on a connector tool                            | 30 days                                 | No                                    | `packages/db/src/tools/persistence.ts:230`                  |
| **Always** on a risky delegation                          | Does not expire                         | No                                    | `packages/db/src/governance/approvalScope.ts:11`            |
| Clawboo Native command prompt                             | 10 minutes                              | No                                    | `apps/web/server/lib/runtimes/native/execTool.ts:47`        |
| Commands a Clawboo Native agent can ask to run in one run | 10                                      | No                                    | `apps/web/server/lib/runtimes/native/execTool.ts:59`        |
| OpenClaw command prompt                                   | The Gateway's deadline, else 30 minutes | No                                    | `apps/web/server/lib/agentSource/execApprovalSurface.ts:45` |
| Age at which a forgotten pending approval is expired      | 24 hours                                | `CLAWBOO_APPROVAL_TTL_MS`             | `apps/web/server/lib/approvalReaper.ts:26`                  |
| How often that cleanup runs                               | Every hour, and once at startup         | `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS` | `apps/web/server/lib/approvalReaper.ts:30`                  |
| Budget warning threshold                                  | 80% of the limit                        | No                                    | `packages/governance/src/budget/math.ts:9`                  |
| Time a task-runner run gets to end once a hard cap trips  | 5 seconds; more work stops it sooner    | No                                    | `apps/web/server/lib/executorRunner.ts:154`                 |

A budget set to hard cap pauses work at 100% of its limit; the default mode only warns. Which runs a cap can stop, and how quickly, depends on the runtime; [Budgets and spend](/using/budgets-and-spend) explains.

## Agent browsers

| Limit                                     | Value                                | Change it                       | Source                                               |
| ----------------------------------------- | ------------------------------------ | ------------------------------- | ---------------------------------------------------- |
| Agent browsers open at once               | 4                                    | `CLAWBOO_MAX_AGENT_BROWSERS`    | `apps/web/server/lib/connectors/agentBrowsers.ts:59` |
| Idle time before an agent browser closes  | 10 minutes                           | `CLAWBOO_AGENT_BROWSER_IDLE_MS` | `apps/web/server/lib/connectors/agentBrowsers.ts:62` |
| Wait for a free browser when all are busy | 60 seconds                           | No                              | `apps/web/server/lib/connectors/agentBrowsers.ts:65` |
| Saved browser screenshots kept in memory  | 24 MiB in total; the oldest go first | No                              | `apps/web/server/lib/screenshotBus.ts:49`            |

## Network and HTTP

| Limit                                                                                 | Value                                       | Change it                                    | Source                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Dashboard port                                                                        | 18790, else the next free of 20 (to 18809)  | `CLAWBOO_API_PORT`, `CLAWBOO_API_PORT_START` | `apps/web/server/lib/portUtils.ts:26,29`                                                                |
| OpenClaw Gateway address                                                              | `ws://localhost:18789`                      | `settings.json`                              | `packages/config/src/index.ts:31`                                                                       |
| Development UI port (`pnpm dev`)                                                      | 5173                                        | No                                           | `packages/gateway-proxy/src/origin-guard.ts:116`                                                        |
| Ollama                                                                                | `http://localhost:11434`                    | `OLLAMA_BASE_URL` (not for memory)           | `apps/web/server/lib/runtimes/native/providers/openai.ts:55`, `packages/db/src/memory/embedding.ts:109` |
| OpenClaw browser debugging port                                                       | 18800 (Gateway port plus 11)                | `CLAWBOO_OPENCLAW_CDP_PORT`                  | `apps/web/server/lib/openclawTabCapture.ts:46`                                                          |
| API requests per client address                                                       | 3,000 per minute                            | No                                           | `apps/web/server/lib/rateLimit.ts:24,29`                                                                |
| Requests to the 26 sensitive routes (installs, sign-ins, connector and runtime setup) | 60 per minute in total, on top of the above | No                                           | `apps/web/server/lib/rateLimit.ts:38`                                                                   |
| Requests for the dashboard's page and files                                           | 3,000 per minute, counted separately        | No                                           | `apps/web/server/lib/rateLimit.ts:47`                                                                   |
| JSON request body                                                                     | 2 MB                                        | No                                           | `apps/web/server/index.ts:322`                                                                          |
| File shown in a task's workspace preview                                              | 8 MiB                                       | No                                           | `apps/web/server/lib/workspacePreview.ts:43`                                                            |

Over a rate limit the server answers 429 with a `Retry-After` header. The [REST API overview](/reference/rest-api/index) lists the sensitive routes.

## Server and CLI

| Limit                                                  | Value                                                                         | Change it                             | Source                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Node.js version                                        | 22.12 or newer                                                                | No                                    | `apps/cli/src/node-version.ts:14-15`             |
| CLI wait for a new server to answer                    | About 45 seconds (90 checks, 500 ms apart)                                    | No                                    | `apps/cli/src/lifecycle.ts:528`                  |
| CLI version check against a running server             | 2 seconds                                                                     | No                                    | `apps/cli/src/lifecycle.ts:312`                  |
| `clawboo stop`: wait after SIGTERM, then after SIGKILL | 4 seconds, then 2 seconds                                                     | No                                    | `apps/cli/src/lifecycle.ts:574,576`              |
| `server.log` size before it rotates to `server.log.1`  | 5 MiB, checked at each launch                                                 | No                                    | `apps/cli/src/server-log.ts:19`                  |
| Log lines shown after a start timeout                  | The last 12, from the final 8 KiB                                             | No                                    | `apps/cli/src/server-log.ts:60`                  |
| A restarted server's wait for its old port             | 15 seconds                                                                    | No                                    | `apps/web/server/index.ts:152`                   |
| Shutdown wait for runtime processes to exit            | 5 seconds                                                                     | No                                    | `apps/web/server/lib/runtimes/subprocess.ts:151` |
| Gateway check at startup                               | 1.5 seconds                                                                   | No                                    | `apps/web/server/lib/defaults.ts:42`             |
| Health check of the server's own MCP servers           | Every minute; a failed one is retried after 30 seconds, doubling to 5 minutes | `CLAWBOO_MCP_PROBE_MS` (the interval) | `apps/web/server/lib/mcpSupervisor.ts:30-32`     |
| Wait for a busy database                               | 250 ms                                                                        | No                                    | `packages/db/src/db.ts:31`                       |
| Retry time for one busy database write                 | 1.5 seconds                                                                   | `CLAWBOO_DB_WRITE_BUDGET_MS`          | `packages/db/src/board/contention.ts:48`         |

## Updates and monitoring

| Limit                                                        | Value                                      | Change it | Source                                                |
| ------------------------------------------------------------ | ------------------------------------------ | --------- | ----------------------------------------------------- |
| Marketplace catalog refresh                                  | Cached 6 hours; 5-second fetch timeout     | No        | `apps/web/server/lib/catalogIndex.ts:65,71`           |
| Check for a newer Clawboo on npm                             | Cached 6 hours; 5-second timeout           | No        | `apps/web/server/lib/updateCheck.ts:107,111`          |
| How often the dashboard asks the server about updates        | At most once an hour                       | No        | `apps/web/src/features/promo/useUpdateCheck.ts:30`    |
| Fleet refresh                                                | Every 8 seconds while the view is visible  | No        | `apps/web/src/features/fleet/FleetHealth.tsx:135`     |
| Quiet time before an agent with an open run shows as stalled | 5 minutes                                  | No        | `packages/obs/src/project/graph.ts:227`               |
| Quiet time before it shows as a zombie (process likely gone) | 30 minutes                                 | No        | `packages/obs/src/project/graph.ts:228`               |
| Events folded into the Fleet and Observability views         | The newest 5,000                           | No        | `apps/web/server/api/obs.ts:96`                       |
| GitHub star count shown in the dashboard                     | Fetched by your browser, cached 10 minutes | No        | `apps/web/src/features/promo/GitHubStarButton.tsx:29` |

## Related

- [Environment variables](/reference/environment-variables): how to set each variable named here
- [Governance](/concepts/governance): what the caps and breakers are for
- [Production defaults](/operating/production-defaults): the default posture of a fresh install
- [CLI reference](/reference/cli): the start, stop and log behavior behind the CLI timings
