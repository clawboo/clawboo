---
title: 'Agent settings API'
sidebarTitle: 'Agent settings'
description: 'REST reference for per-agent personality values, skills, OpenClaw command-execution settings, and the standing exec grants an OpenClaw agent holds.'
keywords: ['misc', 'personality', 'skills', 'exec-settings', 'exec-allowlist', 'standing grants']
---

Per-agent settings that live outside the agent's files: personality slider values, installed skills, and, for OpenClaw agents, command-execution settings and standing exec grants. Use this page when you script agent setup or audit what an OpenClaw agent may run without asking.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. Every route is on the general rate limit; the revoke also counts against the stricter sensitive limit (see the [REST API overview](/reference/rest-api/index)). Errors use `{ "error": "<message>" }` unless a section shows otherwise.

A Clawboo Native agent's command access is a separate switch, `/api/agents/:agentId/shell`, documented in the [Agents API](/reference/rest-api/agents).

## Routes

| Method | Path                         | Summary                                                          | Limit     |
| ------ | ---------------------------- | ---------------------------------------------------------------- | --------- |
| GET    | `/api/personality`           | Read an agent's personality values                               | general   |
| POST   | `/api/personality`           | Save an agent's personality values                               | general   |
| GET    | `/api/skills`                | List installed skills, optionally for one agent                  | general   |
| POST   | `/api/skills`                | Install a skill on an agent, after a safety scan                 | general   |
| DELETE | `/api/skills`                | Remove a skill from an agent                                     | general   |
| GET    | `/api/exec-settings`         | Read an agent's command-execution setting                        | general   |
| GET    | `/api/exec-settings/all`     | Read every agent's `execAsk` value                               | general   |
| POST   | `/api/exec-settings`         | Save the setting, and apply it to OpenClaw for an OpenClaw agent | general   |
| GET    | `/api/exec-allowlist`        | List the commands an OpenClaw agent may run without asking       | general   |
| POST   | `/api/exec-allowlist/revoke` | Take standing exec grants back                                   | sensitive |

## Personality

The six personality sliders and an optional custom text, stored on the agent row as `{ values, customText }`.

The server does not read these values when it builds a prompt. The dashboard turns them into a personality section in the agent's `SOUL.md` and saves that file separately, through `PUT /api/agents/:agentId/files/SOUL.md`. Calling this route alone does not change how an agent behaves.

| Key          | Slider in the dashboard | Default |
| ------------ | ----------------------- | ------- |
| `bite`       | **Bite**                | 45      |
| `spine`      | **Spine**               | 50      |
| `glass`      | **Glass Box**           | 45      |
| `elbows`     | **Elbows**              | 45      |
| `receipts`   | **Receipts**            | 60      |
| `hobbyhorse` | **Hobbyhorse**          | 25      |

The dashboard uses values from 0 to 100. The server stores any `values` object without checking its keys. When the dashboard reads older values, it maps `verbosity` to `glass`, `humor` to `bite` and `caution` to `spine`, and drops `formality` and `speed_cost`.

### `GET /api/personality`

- **Query params**: `agentId` (required).

#### Responses

**`200 OK`**: the stored values, or `null`s when nothing is stored or the stored value cannot be read:

```ts
{ values: Record<string, number> | null, customText: string | null }
```

**`400 Bad Request`**: `{ "error": "agentId required" }`.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl "http://localhost:18790/api/personality?agentId=<agent-id>"
```

### `POST /api/personality`

Saves the values. An `agentId` with no agent row gets a placeholder row (named after the id).

- **Request body**:

```ts
{
  agentId: string // required
  values: Record<string, number> // required, for example { "bite": 60, "spine": 50 }
  customText?: string | null // trimmed; blank is stored as null
}
```

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`400 Bad Request`**: `{ "error": "invalid JSON" }` when the body is not a JSON object, or `{ "error": "agentId and values required" }`.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl -X POST http://localhost:18790/api/personality \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","values":{"bite":60,"spine":50,"glass":45,"elbows":45,"receipts":60,"hobbyhorse":25},"customText":"Concise, dry."}'
```

## Skills

A skill row records that one or more agents have a skill. The skill then shows on those agents in the **Capabilities** panel and on the graphs (it is a `skill` record in `GET /api/capabilities`). This route only records the skill: it downloads and runs nothing. The **Marketplace** installs skills through it with `source: "curated"`.

Each row lists its holders in `metadata.agentIds`, so one row can serve several agents:

```ts
interface SkillRow {
  id: string
  name: string
  source: string // free text, for example "curated"
  category: string | null
  trustScore: number | null // not set by this route
  installedAt: number | null // epoch ms
  metadata: string | null // JSON text: { "agentIds": string[] }
}
```

Skill routes answer errors as `{ "ok": false, "error": "<message>" }`.

### `GET /api/skills`

Lists skills, newest first.

- **Query params**: `agentId` (optional): only skills this agent holds.

#### Responses

**`200 OK`**: `{ ok: true, skills: SkillRow[] }`.

**`500 Internal Server Error`**: `{ ok: false, error: string, skills: [] }`.

#### Example

```bash
curl "http://localhost:18790/api/skills?agentId=<agent-id>"
```

### `POST /api/skills`

Installs a skill on one agent. Before anything is stored, Clawboo's prompt-injection scan checks the name, source, category and the whole request body, at its strictest setting, where every finding blocks the install except a bidirectional-text isolate character, which is let through. A blocked install answers `422`; blocked and clean installs both write an audit row. An existing skill gains the agent as a holder; otherwise a new row is created.

- **Request body**:

```ts
{
  id: string // required
  name: string // required
  source: string // required
  agentId: string // required
  category?: string | null
}
```

#### Responses

**`200 OK`**: `{ ok: true, skill: SkillRow | null }`.

**`400 Bad Request`**: `{ "ok": false, "error": "Invalid JSON body" }`, or `{ "ok": false, "error": "id, name, source, and agentId are required" }` when a required field is not a non-empty string or `category` is not a string.

**`422 Unprocessable Entity`**: the scan blocked the install. The audit row keeps only `pattern`, `line` and `fingerprint` for each finding:

```ts
{
  ok: false
  error: 'skill blocked: injection / supply-chain finding'
  findings: Array<{
    severity: 'exfil' | 'injection' | 'destructive' | 'supply-chain'
    pattern: string
    excerpt: string
    intent: 'language' | 'machine' // aimed at the model, or at the machine
    message: string
    line: number
    fingerprint: string
  }>
}
```

**`500 Internal Server Error`**: `{ ok: false, error: string }`.

#### Example

```bash
curl -X POST http://localhost:18790/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"id":"web-search","name":"Web Search","source":"curated","agentId":"<agent-id>","category":"web"}'
```

### `DELETE /api/skills`

Removes one agent from a skill. When no holder is left, the row is deleted.

- **Query params**: `id` (the skill id) and `agentId`, both required.

#### Responses

**`200 OK`**, one of:

```json
{ "ok": true, "deleted": false, "reason": "skill not found" }
```

```json
{ "ok": true, "deleted": true, "removedRow": true }
```

```json
{ "ok": true, "deleted": true, "removedRow": false }
```

`removedRow: false` means other agents still hold the skill. `deleted: true` does not confirm that this agent held it.

**`400 Bad Request`**: `{ "ok": false, "error": "id and agentId query params are required" }`.

**`500 Internal Server Error`**: `{ ok: false, error: string }`.

#### Example

```bash
curl -X DELETE "http://localhost:18790/api/skills?id=web-search&agentId=<agent-id>"
```

## Exec settings

Each agent's command-execution choice, stored on the agent row (`exec_config`) as `{ execAsk, execSecurity? }`. Only OpenClaw enforces it: for an OpenClaw agent, `POST` also writes the choice into the OpenClaw Gateway's exec-approval policy, the copy OpenClaw checks before it runs a command. The dashboard shows this control, **Command Execution** on the agent's **Permissions** tab, for OpenClaw agents only.

On every other runtime the value is stored and nothing enforces it. Claude Code, Codex and Hermes run with their own approval prompts turned off; see [What agents can do](/concepts/permissions).

| `execAsk` | Dashboard label     | What `POST` writes into OpenClaw's policy for this agent                                                                                                      |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | **Run Freely**      | Removes the agent's own `ask` and `security`, so OpenClaw falls back to the fleet-wide (`*`) entry and then to the policy defaults. Standing grants are kept. |
| `on-miss` | **Ask for Unknown** | `security: "allowlist"` and `ask: "on-miss"`. Standing grants are kept.                                                                                       |
| `always`  | **Always Ask**      | `security: "allowlist"` and `ask: "always"`. Standing grants are kept.                                                                                        |

`execSecurity` is stored but never sent to OpenClaw.

<Warning>
`POST /api/exec-settings` replaces the whole stored value. A Claude Code, Codex or Hermes agent keeps the model and provider picked for it in that same field. Posting here for one of those agents drops that choice, and the agent falls back to its default model.
</Warning>

### `GET /api/exec-settings`

Reads Clawboo's stored copy, not OpenClaw's policy. To see what OpenClaw holds, read `storedAsk` from `GET /api/exec-allowlist`.

- **Query params**: `agentId` (required).

#### Responses

**`200 OK`**: the stored value, or `null` when nothing is stored. Other fields stored in the same place come back too:

```ts
{ values: { execAsk: string; execSecurity?: string } | null }
```

**`400 Bad Request`**: `{ "error": "agentId required" }`.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl "http://localhost:18790/api/exec-settings?agentId=<agent-id>"
```

### `GET /api/exec-settings/all`

Every agent's stored `execAsk`, keyed by agent id. Agents with nothing stored, or whose stored value has no string `execAsk`, are left out.

#### Responses

**`200 OK`**:

```ts
{
  configs: Record<string, { execAsk: string }>
}
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/exec-settings/all
```

### `POST /api/exec-settings`

Stores the value first, then, for an OpenClaw agent, writes it into OpenClaw's policy under OpenClaw's own id for the agent. A refusal from the Gateway never loses what you sent. An `agentId` with no agent row gets a placeholder row (named after the id).

- **Request body**:

```ts
{
  agentId: string // required
  values: { execAsk: string; execSecurity?: string } // required
}
```

#### Responses

**`200 OK`**: stored, and OpenClaw accepted the setting:

```json
{ "ok": true, "gateway": "applied" }
```

**`200 OK`**: stored, with no OpenClaw policy to write. This is the answer for every other runtime, and for an OpenClaw agent row with no OpenClaw id:

```json
{ "ok": true, "gateway": "not-applicable" }
```

**`400 Bad Request`**: `{ "error": "invalid JSON" }` when the body is not a JSON object, or `{ "error": "agentId and values required" }`.

**`400 Bad Request`**: an OpenClaw agent with an `execAsk` other than `off`, `on-miss` or `always`. The value is already stored by then; on other runtimes any string is stored and answered `not-applicable`:

```json
{ "error": "unknown execAsk: <value>" }
```

**`502 Bad Gateway`**: stored in Clawboo, but the Gateway refused it, so what the agent is held to did not change. `ok` is `false` and `savedLocally` is `true`:

```json
{
  "ok": false,
  "savedLocally": true,
  "error": "saved in clawboo, but the Gateway did not accept it: <reason>"
}
```

After a `502`, `GET /api/exec-settings` returns the value you sent, not the one in force. Retry until the `POST` answers `200`, or read `storedAsk` from `GET /api/exec-allowlist` to see what OpenClaw holds.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl -X POST http://localhost:18790/api/exec-settings \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","values":{"execAsk":"always"}}'
```

## Standing exec grants

The commands an OpenClaw agent may already run without asking, and the way to take them back. Answering **Always** to a command prompt creates such a grant. These two routes back the **Commands this Boo can run without asking** card on the agent's **Permissions** tab. Only OpenClaw keeps standing exec grants, so both routes are OpenClaw-only.

The read never calls the Gateway, because OpenClaw's read call (`exec.approvals.get`) also writes the policy back. Instead it opens OpenClaw's state database read-only at `<state dir>/state/openclaw.sqlite`. The state dir is `OPENCLAW_STATE_DIR` (or the older `MOLTBOT_STATE_DIR` or `CLAWDBOT_STATE_DIR`) when set, otherwise `~/.openclaw`, or an existing `~/.clawdbot` or `~/.moltbot` when `~/.openclaw` does not exist. The policy's internal socket token is never returned. Only the revoke talks to the Gateway.

<Note>
An empty list is a safety claim, so these routes never produce one by accident. "No grants", "no policy on this machine" and "a policy that could not be read" are three different answers with three different `state` values. Never show `unreadable` as an empty list: those grants are still on disk and still enforced.
</Note>

### `GET /api/exec-allowlist`

Reads one agent's grants from OpenClaw's stored policy, plus the fleet-wide `*` entry. OpenClaw applies the fleet-wide rows to this agent too, but they are not this agent's to revoke, so the two lists are returned separately.

- **Query params**: `agentId` (required): Clawboo's id for the agent. The route looks up OpenClaw's id itself.

#### Responses

**`200 OK`**, `state: 'ok'`: the policy was read. `entries` is this agent's own list, the only rows a revoke can remove:

```ts
{
  state: 'ok'
  sourceAgentId: string // OpenClaw's id for this agent
  entries: ExecAllowlistRow[] // this agent's own grants
  wildcard: ExecAllowlistRow[] // the fleet-wide '*' entry: applies here, not revocable here
  duplicatedInWildcard: string[] // keys that appear in both lists
  storedSecurity: string | null // what OpenClaw holds for this agent
  storedAsk: string | null
  defaultSecurity: string | null // the policy defaults a missing field falls back to
  defaultAsk: string | null
  updatedAtMs: number
}

interface ExecAllowlistRow {
  key: string // a fingerprint of the row's content; pass it back to revoke
  pattern: string
  argPattern: string | null
  source: string | null
  classification: ExecAllowlistClass // see the table below
  bucket: 'agent' | 'wildcard'
  lastUsedCommand: string | null // never set for a grant made with Always
  lastResolvedPath: string | null
  lastUsedAt: number | null
}
```

| `classification`      | What the row allows                                                     |
| --------------------- | ----------------------------------------------------------------------- |
| `bound-grant`         | One exact command, in one folder (what **Always** creates)              |
| `exact-command-grant` | One exact command, in any folder                                        |
| `path-rule`           | One program, with any arguments, in any folder                          |
| `arg-rule`            | One program, with matching arguments                                    |
| `catch-all`           | Any command at all                                                      |
| `node-marker`         | Nothing on its own, but the grant it came with stops working without it |
| `inert-allow-always`  | Nothing: an **Always** row that OpenClaw skips                          |
| `inert`               | Nothing: a malformed row, or one that can never match                   |

**`200 OK`**, `state: 'absent'`: there is no policy on this machine, so nothing is granted to any agent:

```json
{ "state": "absent", "sourceAgentId": "<openclaw-agent-id>" }
```

**`200 OK`**, `state: 'not-applicable'`: the agent is not on OpenClaw, or its row has no OpenClaw id:

```json
{ "state": "not-applicable", "runtime": "clawboo-native" }
```

**`502 Bad Gateway`**, `state: 'unreadable'`: the policy exists and could not be read. The counts come from the last successful save and cover every agent in the policy, not only this one (both are `0` when the database itself could not be opened). This response has **no `entries` key**, so a client cannot mistake it for an empty list:

```ts
{
  state: 'unreadable'
  sourceAgentId: string
  error: string // redacted reason
  knownAgentCount: number
  knownAllowlistCount: number
}
```

**`400 Bad Request`**: `{ "error": "agentId required" }`.

**`404 Not Found`**: `{ "error": "agent not found" }`.

**`500 Internal Server Error`**: any other failure, redacted, `{ "error": "<message>" }`.

#### Example

```bash
curl "http://localhost:18790/api/exec-allowlist?agentId=<agent-id>"
```

### `POST /api/exec-allowlist/revoke`

Removes rows from one agent's own list. The Gateway has no call that removes one row, so the route rewrites OpenClaw's whole policy through the Gateway, with a check that nothing else changed it in between. Every other agent's policy is carried over unchanged; this agent keeps its own `security` and `ask`; an emptied list is kept rather than removed. Success is checked against the policy the Gateway returns after the write.

On the sensitive rate limit as well as the general one.

- **Request body**:

```ts
{
  agentId: string // Clawboo's id for the agent
  keys: string[] // 1 to 200 keys, each a `key` from the GET
}
```

Pass `key` values back exactly as the GET returned them: a key is a fingerprint of the row's `pattern`, `argPattern` and `source`, not an id. Revoke a grant made with **Always** together with its `node-marker` row, in the same call.

#### Responses

**`200 OK`**, outcome `revoked`: the rows are gone, confirmed against the Gateway's reply. `remaining` counts the rows this agent still has:

```json
{ "outcome": "revoked", "removed": 2, "remaining": 3 }
```

**`409 Conflict`**: nothing was written. One of:

```json
{ "outcome": "already-absent", "error": "those grants were already gone" }
```

```json
{
  "outcome": "blocked-wildcard",
  "keys": ["<key>"],
  "error": "that grant is set for every Boo, not just this one, so it cannot be removed here"
}
```

```json
{ "outcome": "no-such-agent", "error": "this Boo has no policy to change" }
```

`blocked-wildcard` means a key is also in the fleet-wide `*` entry, so removing this agent's copy would leave the command allowed. One such key refuses the whole call; `keys` names them.

**`502 Bad Gateway`**, outcome `not-verified`: the write went through, but the Gateway's reply still lists those rows, or came back with no policy to check:

```json
{
  "outcome": "not-verified",
  "keys": ["<key>"],
  "error": "the Gateway accepted the change and still lists those grants"
}
```

<Warning>
`not-verified` is the one outcome that is not a no-op: the write landed and could not be confirmed. Read `GET /api/exec-allowlist` again before you act, and do not report the grant as gone.
</Warning>

**`502 Bad Gateway`**: the Gateway call failed (for example, no Gateway connection). Its message is passed through, redacted:

```json
{ "state": "failed", "error": "<message>" }
```

**`400 Bad Request`**: no `agentId`, or `keys` is missing, empty, longer than 200, or holds a non-string or empty entry:

```json
{ "error": "agentId and a non-empty keys array are required" }
```

**`400 Bad Request`**: the agent is not on OpenClaw, or its row has no OpenClaw id:

```json
{ "error": "this runtime keeps no standing exec grants" }
```

**`404 Not Found`**: `{ "error": "agent not found" }`.

**`429 Too Many Requests`**: the sensitive limit:

```json
{ "error": "Too many requests for this operation. Wait a moment and retry." }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/exec-allowlist/revoke \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","keys":["<key-from-the-GET>"]}'
```

**Source of truth:** `apps/web/server/api/personality.ts`, `skills.ts`, `execSettings.ts` and `execAllowlist.ts`; the OpenClaw policy read is `apps/web/server/lib/agentSource/openclawExecAllowlistRead.ts`, the policy write is `packages/gateway-client/src/execApprovals.ts`, the revoke `execRevoke.ts`, and the row classes `execAllowlist.ts`.

## Related

- [Review and revoke command permissions](/using/command-permissions): the Permissions tab over these routes
- [What agents can do](/concepts/permissions): what each runtime may do on its own, and why a worktree is not a sandbox
- [Agents API](/reference/rest-api/agents): agent files (where `SOUL.md` lives) and the Clawboo Native shell switch
- [Capabilities API](/reference/rest-api/capabilities): where installed skills show up
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): resolving an approval that can create a standing grant
