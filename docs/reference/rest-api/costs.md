---
title: 'Costs and fleet API'
sidebarTitle: 'Costs and fleet'
description: 'REST reference for token cost records, the 30-day summary behind Tokens Used, and the fleet summary behind the Fleet panel.'
keywords: ['misc', 'cost records', 'cost-records', 'tokens used', 'fleet', 'spend', 'fleet summary']
---

Read and write token cost records, the 30-day summary the **Tokens Used** panel shows, and the fleet overview the **Fleet** panel shows. Use this page when you build your own spend report or health dashboard.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. All four routes are on the general rate limit described in the [REST API overview](/reference/rest-api/index). Errors use `{ "error": "<message>" }`.

## Routes

| Method | Path                        | Summary                                                                  |
| ------ | --------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/cost-records`         | List cost records, newest first                                          |
| POST   | `/api/cost-records`         | Record one run's token usage with an estimated cost                      |
| GET    | `/api/cost-records/summary` | Totals, per-agent totals and a daily series for the last 30 days         |
| GET    | `/api/fleet/summary`        | Agents per runtime, 24-hour task and verification counts, spend, budgets |

## Cost records

A cost record is one run's token counts plus a price. The server records each OpenClaw Gateway turn itself, and those rows carry a `sessionKey`. Rows posted through `POST /api/cost-records` (by your own script, or by the dashboard for a Gateway turn of an agent it does not list as OpenClaw) have `sessionKey: null`. The server also writes one record for each Clawboo Native, Claude Code, Codex or Hermes run when it settles the run's cost, on the task runner (agent routines and API runs) and in team chat. Those rows carry a `sessionKey` too, and `runId` is the run's execution id when it has one. When the run reported no token counts, they are guessed from the text at about 4 characters per token. One-to-one chats with these agents write no records, and runs from before these records were added are not backfilled.

A cost record is a report only. Writing one does not charge a budget; budget spend is tracked separately (see the [Governance API](/reference/rest-api/governance)). Deleting an agent deletes its cost records.

<Note>
On rows the server records for OpenClaw turns, and on rows posted through `POST /api/cost-records`, `costUsd` is an estimate from a built-in price list, never a figure a provider reported. The list covers Anthropic Claude models plus `gpt-4o` and `gpt-4o-mini`. A model your own Ollama serves is priced at `$0`: an `ollama/` model id, or an OpenClaw turn the Gateway says Ollama served, unless its tag marks one of Ollama's cloud models (`-cloud` or `:cloud`). Any other model is priced at `$3` per million input tokens and `$15` per million output tokens. A row for another runtime's run carries the cost that run recorded: Claude Code's reported figure, or Clawboo's estimate. For which runtimes report real provider cost, see [Budgets and spend](/using/budgets-and-spend).
</Note>

The record shape, returned by both cost-record routes:

```ts
interface CostRecord {
  id: number
  agentId: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number // see the note above
  runId: string | null
  sessionKey: string | null // set on rows the server records itself; null on rows from POST
  createdAt: number // epoch ms
}
```

### `GET /api/cost-records`

Lists cost records, newest first, at most 500.

- **Query params**:

| Param     | Type                           | Default | Notes                                                                                           |
| --------- | ------------------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `period`  | `'today' \| 'week' \| 'month'` | none    | `today` starts at midnight, server time; `week` is the last 7 days and `month` the last 30 days |
| `agentId` | string                         | none    | Only this agent's records                                                                       |

Any other `period` value applies no time filter.

#### Responses

**`200 OK`**:

```ts
{
  records: CostRecord[]
}
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl "http://localhost:18790/api/cost-records?period=week&agentId=<agent-id>"
```

### `POST /api/cost-records`

Records one run's token usage. The server prices it with the built-in list and stores the result. An `agentId` with no agent row gets a placeholder row (named after the id) so the record can be stored.

- **Request body**:

```ts
{
  agentId: string // required
  model: string // required; picks the price
  inputTokens: number // required; 0 is allowed
  outputTokens: number // required; 0 is allowed
  runId?: string | null
}
```

Model ids match the price list exactly first, then by substring with dots read as dashes, so `anthropic/claude-haiku-4.5` is priced as `claude-haiku-4-5`.

#### Responses

**`200 OK`**: the stored record:

```ts
{ ok: true, record: CostRecord }
```

**`400 Bad Request`**: the body is not a JSON object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: `agentId` or `model` is empty, or a token count is missing:

```json
{ "error": "agentId, model, inputTokens, outputTokens required" }
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl -X POST http://localhost:18790/api/cost-records \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","model":"claude-sonnet-4-6","inputTokens":1200,"outputTokens":340}'
```

### `GET /api/cost-records/summary`

Totals for the **Tokens Used** panel, built from the records of the last 30 days. Every window starts at midnight in the server's time zone: today, 7 days ago, and 30 days ago. Takes no parameters.

#### Responses

**`200 OK`**:

```ts
{
  totalToday: number // USD, see the note above
  totalWeek: number
  totalMonth: number
  tokensToday: number // input + output tokens
  tokensWeek: number
  tokensMonth: number
  byAgent: Array<{
    agentId: string
    agentName: string // the agent's name, or its id when no agent row exists
    totalCost: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    messageCount: number // number of records
  }> // most tokens first
  timeSeries: Array<{
    date: string // en-US short date, for example "Oct 28"
    cost: number
    tokens: number
  }> // 30 entries, oldest first, from 29 days ago through today; days with no records are 0. Records from 30 days ago count in the month totals but have no entry here.
}
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/cost-records/summary
```

## Fleet summary

### `GET /api/fleet/summary`

A read-only overview built from data Clawboo already stores: agents per runtime, board tasks and verification verdicts from the last 24 hours, recorded task cost, and budgets. It backs the **Fleet** panel in Settings. Takes no parameters.

#### Responses

**`200 OK`**:

```ts
{
  generatedAt: number // epoch ms
  tenantId: null // always null
  totalAgents: number // agents that are not archived
  runtimes: Array<{
    runtime: string
    runtimeClass: 'connected-substrate' | 'wrapped-oneshot' | 'native'
    healthOk: boolean | null
    agentCount: number
    healthy: number // agents with status idle or running
    degraded: number // agents with status error
    down: number // agents with any other status
  }>
  tasks24h: {
    total: number
    done: number
    cancelled: number
    inProgress: number // in_progress or in_review
    passRate: number | null
  }
  verification24h: {
    total: number
    pass: number
    fail: number
    debt: number // completed with debt
    passRate: number | null
  }
  spend24hUsd: number
  budgets: {
    count: number
    paused: number
  }
}
```

| Field             | Meaning                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes`        | One row per runtime that has agents or reports health. `openclaw`, `claude-code`, `codex`, `hermes` and `clawboo-native` are always listed, with zero counts when they have no agents. Sorted by `agentCount`, then by name.                          |
| `runtimeClass`    | `connected-substrate` is OpenClaw, a Gateway that runs on its own and Clawboo connects to. `wrapped-oneshot` is a runtime Clawboo starts for each run (Claude Code, Codex, Hermes). `native` is Clawboo Native, which runs inside the server.         |
| `healthOk`        | OpenClaw: the server's Gateway connection is up. Claude Code, Codex, Hermes: the `claude`, `codex` or `hermes` command was found on this machine. Clawboo Native: a provider key is connected or local Ollama is set up. `null` when nothing reports. |
| `tasks24h`        | Board tasks **updated** in the last 24 hours. `passRate` is `done / (done + cancelled)`, or `null` when none finished.                                                                                                                                |
| `verification24h` | Verdicts on those same tasks. `passRate` is `pass / total`, or `null` when there are no verdicts.                                                                                                                                                     |
| `spend24hUsd`     | The total recorded cost of the tasks updated in the last 24 hours. A long task touched today counts its whole cost, so this is not the money spent in the last 24 hours.                                                                              |
| `budgets`         | How many budgets exist, and how many are paused.                                                                                                                                                                                                      |

**`500 Internal Server Error`**: building the summary failed, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/fleet/summary
```

**Source of truth:** `apps/web/server/api/costRecords.ts`, `costRecordsSummary.ts`, `fleet.ts`, and the price list in `apps/web/server/lib/costUtils.ts`.

## Related

- [Budgets and spend](/using/budgets-and-spend): which runtimes report real cost, and the Tokens Used panel
- [Governance API](/reference/rest-api/governance): budgets, caps and the audit log
- [Observability API](/reference/rest-api/observability): the event log and fleet health triage
- [Board API](/reference/rest-api/board): task cost and the execution ledger behind `spend24hUsd`
- [Database schema](/reference/database-schema): the `cost_records` table
