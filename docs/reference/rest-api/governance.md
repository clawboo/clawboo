---
title: 'Governance API'
sidebarTitle: 'Governance'
description: 'REST reference for budgets (spend tracking, optional hard caps, resume), the audit log, delegation approvals, and the approval-decision history.'
keywords:
  [
    'governance',
    'budgets',
    'hard cap',
    'warn only',
    'spend',
    'audit log',
    'approvals',
    'delegation approval',
  ]
---

These routes cover [governance](/concepts/governance): spend budgets, the audit log, the approval a team lead gives before a risky delegation runs, and a history of approval decisions. For the dashboard side, see [Budgets and spend](/using/budgets-and-spend).

How budgets behave:

- A scope is tracked only once it has a budget row. A scope is an `agent`, a `team`, a `mission` (a top-level task and every task delegated under it, keyed by the top-level task's id) or a `tenant`. You create rows with `POST /api/governance/budgets`. Clawboo also creates one when a native agent is created with `execConfig.budgetUsd` above 0: an agent budget in `cap` mode.
- A budget is in `warn` mode unless you send `mode: 'cap'`. A `warn` budget tracks spend and moves to `soft_capped` from 80% of its limit, but it never pauses anything. Only a `cap` budget reaches `paused` at 100% and stops runs.
- Nothing charges a `tenant` budget: the route accepts one, but no run records spend against it.
- Spend is recorded by the server as runs report it, not through these routes. Which runs a hard cap can stop before they spend more depends on the runtime and on how the run started; see [Governance](/concepts/governance).

The audit log is always written. Every route here is on the general rate tier (see [rate limits](/reference/rest-api/index#rate-limits)).

## Routes

| Method | Path                                             | Summary                                                               | Stream? |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------- | ------- |
| GET    | `/api/governance/budgets`                        | List every budget                                                     | No      |
| POST   | `/api/governance/budgets`                        | Create a budget, or change its limit and mode                         | No      |
| POST   | `/api/governance/budgets/:scope/:scopeId/resume` | Resume a paused budget, optionally with extra headroom                | No      |
| GET    | `/api/governance/audit`                          | Read the audit log (filterable)                                       | No      |
| POST   | `/api/governance/delegation-approval`            | Ask a team lead to approve a risky delegation (waits up to 5 minutes) | No      |
| GET    | `/api/approvals`                                 | List stored approval decisions                                        | No      |
| POST   | `/api/approvals`                                 | Store an approval decision                                            | No      |

<Info>

Two separate approval records live here. `POST /api/governance/delegation-approval` opens a live approval in the `tool_call_approvals` table and waits for the answer. `/api/approvals` reads and writes `approval_history`, a plain log of past allow and deny decisions. The two never write the same table.

</Info>

---

## `GET /api/governance/budgets`

Lists every budget, most recently updated first. The route has no filters.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  budgets: Array<{
    id: string
    scope: 'agent' | 'mission' | 'team' | 'tenant'
    scopeId: string
    limitUsdCents: number
    spentUsdCents: number // whole cents: floor(spentMicroCents / 10000)
    spentMicroCents: number // the exact spend, in millionths of a dollar (10,000 per cent)
    status: 'active' | 'soft_capped' | 'paused'
    mode: 'cap' | 'warn'
    tenantId: string | null
    createdAt: number // epoch ms
    updatedAt: number // epoch ms
  }>
}
```

`status` is `active` below 80% of the limit and `soft_capped` from 80%. Only a `cap` budget becomes `paused`, at 100%, and stays paused until you resume it or raise its limit. A `warn` budget stops at `soft_capped` however far spend goes.

### Example

```bash
curl http://localhost:18790/api/governance/budgets
```

---

## `POST /api/governance/budgets`

Creates a budget for a scope, or changes the limit and mode of an existing one. A new budget starts at 0 spent and `active`. Changing the limit recomputes `status` from the spend so far, so raising the limit above the current spend un-pauses a `cap` budget.

- **Path/query params**: none.
- **Request body**:

```ts
{
  scope: 'agent' | 'mission' | 'team' | 'tenant'  // required
  scopeId: string                                  // required, non-empty
  limitUsdCents: number                            // required, a positive integer (0 is refused)
  mode?: 'cap' | 'warn'                            // 'warn' unless you send 'cap', on every write
  tenantId?: string | null
}
```

<Warning>

`mode` is applied on every write, not only on create. Re-sending a `cap` budget without `mode: 'cap'`, for example to raise its limit, turns it into a `warn` budget and removes the hard stop. Always send `mode: 'cap'` when you update a hard cap.

</Warning>

A limit of `0` is refused: a budget is a positive limit, and an untracked scope is one with no row. There is no delete route; to stop a cap, change it to `warn` or raise its limit.

### Responses

**`200 OK`**: the budget as stored:

```ts
{
  budget: {
    id: string
    scope: 'agent' | 'mission' | 'team' | 'tenant'
    scopeId: string
    limitUsdCents: number
    spentUsdCents: number
    spentMicroCents: number
    status: 'active' | 'soft_capped' | 'paused'
    mode: 'cap' | 'warn'
    tenantId: string | null
    createdAt: number
    updatedAt: number
  }
}
```

**`400 Bad Request`**: the body failed validation (an unknown scope, a missing `scopeId`, a limit that is not a positive integer). `details` is the zod `flatten()` output:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

### Example

```bash
# A $5.00 hard cap on a team: runs for this team stop when it is spent
curl -X POST http://localhost:18790/api/governance/budgets \
  -H 'Content-Type: application/json' \
  -d '{"scope":"team","scopeId":"<team-id>","limitUsdCents":500,"mode":"cap"}'
```

---

## `POST /api/governance/budgets/:scope/:scopeId/resume`

Sets a paused budget back to `active`. If the spend has already reached the limit, the next recorded cost pauses it again; send `graceUsdCents` to raise the limit to the current spend plus that amount, so work can continue. A resume with grace keeps the budget's mode. The response carries `willRepause: true` when you resume a budget at or over its limit without grace.

- **Path params**:

| Param     | Type                                         | Notes                                         |
| --------- | -------------------------------------------- | --------------------------------------------- |
| `scope`   | `'agent' \| 'mission' \| 'team' \| 'tenant'` | Any other value is a **400**                  |
| `scopeId` | string                                       | The scope's id; matched together with `scope` |

- **Request body** (optional):

```ts
{
  graceUsdCents?: number  // a positive integer: headroom when spend is at or over the limit
}
```

### Responses

**`200 OK`**: the resumed budget and the re-pause warning. `willRepause` is `true` when `spentUsdCents >= limitUsdCents`:

```ts
{
  budget: {
    /* the same shape as POST /api/governance/budgets */
  }
  willRepause: boolean
}
```

**`400 Bad Request`**: `:scope` is not one of the four scopes:

```json
{ "error": "invalid scope" }
```

**`400 Bad Request`**: the body failed validation (for example a `graceUsdCents` that is not a positive integer):

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`404 Not Found`**: no budget exists for that `scope` and `scopeId`:

```json
{ "error": "budget not found" }
```

### Example

```bash
# Resume a paused team budget with $1.00 (100 cents) of headroom
curl -X POST http://localhost:18790/api/governance/budgets/team/<team-id>/resume \
  -H 'Content-Type: application/json' \
  -d '{"graceUsdCents":100}'
```

---

## `GET /api/governance/audit`

Reads the append-only audit log, newest first: installs, approvals, tool calls, budget events, cap hits, check results and circuit breaks. There is no write route; the server writes these rows itself. Each row's `summary` was scrubbed of secrets when it was written, and is masked again before it is sent.

The 80% and 100% budget warnings (`eventType: 'budget'`) are written by task-runner runs and OpenClaw Routine fires. Team chat and 1:1 chat update the budget row without writing a warning row.

- **Query params**:

| Param       | Type                                                                                                   | Default | Notes                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------- |
| `agentId`   | string                                                                                                 | none    | Only this agent's rows                                     |
| `eventType` | `'install' \| 'approval' \| 'tool_call' \| 'budget' \| 'cap_hit' \| 'verification' \| 'circuit_break'` | none    | Any other value is ignored                                 |
| `since`     | number                                                                                                 | none    | `createdAt` lower bound (epoch ms); used only when above 0 |
| `limit`     | number                                                                                                 | `200`   | At most 1000; used only when above 0                       |

- **Request body**: none.

### Responses

**`200 OK`**: the matching rows (an empty list when nothing matches):

```ts
{
  audit: Array<{
    id: string
    eventType:
      'install' | 'approval' | 'tool_call' | 'budget' | 'cap_hit' | 'verification' | 'circuit_break'
    agentId: string | null
    taskId: string | null
    teamId: string | null
    tenantId: string | null
    summary: string // JSON text, scrubbed and masked
    createdAt: number // epoch ms
  }>
}
```

### Example

```bash
# The last 50 budget events for one agent
curl "http://localhost:18790/api/governance/audit?agentId=<agent-id>&eventType=budget&limit=50"
```

---

## `POST /api/governance/delegation-approval`

Asks a team lead to approve a risky delegation before it runs. If the lead has answered **Always** for this kind of delegation before, the route answers `allow_always` at once. Otherwise it opens a pending approval in `tool_call_approvals` (it appears in the [approval cards](/using/approvals)) and holds the request open until the lead answers or the approval expires. The approval's key is `delegate:<kind>`.

The wait is fixed at 5 minutes: the approval expires 5 minutes after it is created, and the request gives up at the same time. `CLAWBOO_APPROVAL_TTL_MS` (24 hours by default) does not change this wait. It sets how old an abandoned pending approval must be before the hourly cleanup expires it and unblocks any task it was holding.

- **Path/query params**: none.
- **Request body**:

```ts
{
  leaderAgentId: string       // required
  kind?: string               // the delegation kind; the key is 'delegate:<kind>'; default 'code'
  targetAgentName?: string    // the agent the work goes to (shown in the prompt)
  task?: string               // what is being delegated
  taskId?: string             // the board task this approval gates, so the cleanup can unblock it
}
```

### Responses

**`200 OK`**: the outcome. Each one writes an `approval` audit row, except a `timeout` caused by a server error:

```ts
{
  resolution: 'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'
}
```

`expired` means the 5 minutes ran out. `timeout` means the approval row disappeared, or the server hit an error while waiting: the route never answers `500`, it answers `timeout`. Treat `deny`, `expired` and `timeout` alike: do not run the delegation.

One `allow_always` answer skips the prompt for that lead and kind on every later request. No route withdraws it.

**`400 Bad Request`**: missing `leaderAgentId`:

```json
{ "error": "leaderAgentId required" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/governance/delegation-approval \
  -H 'Content-Type: application/json' \
  -d '{"leaderAgentId":"<leader-id>","kind":"code","targetAgentName":"Reviewer Boo","task":"run the destructive migration"}'
```

---

## `GET /api/approvals`

Lists stored approval decisions from `approval_history`, newest first. This is a plain log, separate from the live approvals above.

- **Query params**:

| Param     | Type   | Default | Notes                                                                       |
| --------- | ------ | ------- | --------------------------------------------------------------------------- |
| `agentId` | string | none    | Only this agent's decisions                                                 |
| `limit`   | number | `50`    | Kept between 1 and 200. Send a number: a non-numeric value skips that clamp |

- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  ok: true
  records: Array<{
    id: number
    agentId: string
    action: string // 'allow-once' | 'allow-always' | 'deny', as stored by POST
    toolName: string
    details: string | null // JSON text
    createdAt: number // epoch ms
  }>
}
```

**`500 Internal Server Error`**: a database error, with an empty list:

```json
{ "ok": false, "error": "<message>", "records": [] }
```

### Example

```bash
curl "http://localhost:18790/api/approvals?agentId=<agent-id>&limit=50"
```

---

## `POST /api/approvals`

Stores one approval decision in `approval_history` and returns the stored row.

- **Path/query params**: none.
- **Request body**:

```ts
{
  agentId: string                                   // required
  action: 'allow-once' | 'allow-always' | 'deny'    // required
  toolName: string                                  // required
  details?: Record<string, unknown> | null          // stored as JSON text
}
```

### Responses

**`200 OK`**: the stored row (`null` if the insert returned nothing):

```ts
{
  ok: true
  record: {
    id: number
    agentId: string
    action: string
    toolName: string
    details: string | null
    createdAt: number
  } | null
}
```

**`400 Bad Request`**: one of:

```json
{ "ok": false, "error": "Invalid JSON body" }
```

```json
{ "ok": false, "error": "agentId, action, and toolName are required" }
```

```json
{ "ok": false, "error": "Invalid action" }
```

**`500 Internal Server Error`**: the insert failed:

```json
{ "ok": false, "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/approvals \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","action":"allow-always","toolName":"web_search"}'
```

---

## Error envelope

The budget, audit and delegation-approval routes answer validation errors as `{ "error": "<message>" }`, adding a zod `details` object on the budget routes. The budget and audit routes do not catch database errors: one reaches Express's default handler and comes back as an HTML `500`, not JSON. The delegation approval never answers `500`; it answers `timeout`. The `/api/approvals` routes answer `{ "ok": false, "error": "<message>" }`, and the `GET` adds `records: []` on its `500`.

On the default loopback bind no token is needed for these routes, though the same-origin guard still refuses cross-origin browser requests. A non-loopback bind without `STUDIO_ACCESS_TOKEN` stops the server at startup unless `CLAWBOO_ALLOW_INSECURE=1` is set. With the token set, the access gate covers every route here. See the [REST API overview](/reference/rest-api/index) and [Security](/operating/security).

## Related

- [Governance](/concepts/governance): budgets, hard caps, circuit breakers and approvals, and which runs each one covers.
- [Budgets and spend](/using/budgets-and-spend): set a budget in the dashboard, and how spend is counted per runtime.
- [Approvals](/using/approvals): where a team lead answers a delegation approval.
- [Verification](/concepts/verification): what writes `verification` audit rows.
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): the tool approval queue in the same `tool_call_approvals` table.
- [Environment variables](/reference/environment-variables): `CLAWBOO_APPROVAL_TTL_MS` and the cleanup interval.
