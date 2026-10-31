---
title: Teams API
description: 'REST reference for teams and their sub-resources: CRUD, agent membership, chat rooms, the Know-Your-Team onboarding gate, team rules, the team chat, and the peer-chat room.'
---

REST surface for [teams](/appendices/glossary) and everything scoped to a team: team CRUD, agent→team membership, the team's chat rooms, the per-team "Know Your Team" onboarding flags, the durable team-rules text, the server-orchestrated chat surface (ingest, stop, clear, SSE tail) plus its activity snapshot, and the mixed-runtime peer-chat room (read + the explicit exchange kickoff).

Teams are stored in the SQLite `teams` table; agent membership is the nullable `agents.teamId` FK (one-to-one: an agent belongs to at most one team). A team's chat rooms are the `rooms` and `room_members` tables. Onboarding flags and team rules are NOT tables; they are JSON blobs in the `settings` key/value table under the keys `team-onboarding:<teamId>` and `team-rules:<teamId>`. The peer-chat room is the `team_chat` table (the same one the [TeamChat MCP server](/reference/rest-api/tools-and-mcp) writes).

<Note>
Deleting a team **orphans** its agents (sets `agents.teamId = null`) rather than deleting them, and cleans up the team-scoped `settings` rows. The agents themselves are managed through the [agents API](/reference/rest-api/agents).
</Note>

<Note>
Two different things on this page are called rooms. A team's **chat rooms** (`/api/teams/:id/rooms`, and the `roomId` the chat routes take) are conversations inside the team's group chat, each with a subset of its members. The team's own group chat, **General**, is the default room: it has no room row, and leaving `roomId` out means General. The **peer-chat room** (`/api/team-chat`, whose `roomId` is `team:<teamId>`) is the TeamChat MCP substrate, and its id is never a chat room id.
</Note>

All POST/PATCH/PUT routes read a JSON body parsed by `express.json({ limit: '2mb' })`. Two different path-param names appear in this group: the team CRUD, rooms, onboarding, chat, and activity routes use `:id` (the single-room routes add `:roomId`), while the team-rules routes use `:teamId`; both are the team id, the difference is purely the registered param name.

## Routes

| Method | Path                              | Summary                                                      | Stream? |
| ------ | --------------------------------- | ------------------------------------------------------------ | ------- |
| GET    | `/api/teams`                      | List teams with `agentCount`, plus agent→team assignments    | No      |
| GET    | `/api/teams/member-roles`         | Each team member's one-line role, for New task suggestions   | No      |
| POST   | `/api/teams`                      | Create a team (optional client-provided UUID)                | No      |
| PATCH  | `/api/teams/:id`                  | Update a team (partial)                                      | No      |
| DELETE | `/api/teams/:id`                  | Delete a team, orphan its agents, clean team-scoped settings | No      |
| POST   | `/api/teams/:id/agents`           | Assign (upsert) an agent into the team                       | No      |
| DELETE | `/api/teams/:id/agents/:agentId`  | Remove an agent from a team                                  | No      |
| GET    | `/api/teams/:id/rooms`            | List the team's chat rooms                                   | No      |
| POST   | `/api/teams/:id/rooms`            | Create a chat room from a subset of the team's members (201) | No      |
| PATCH  | `/api/teams/:id/rooms/:roomId`    | Rename a room, replace its members, or pin it                | No      |
| DELETE | `/api/teams/:id/rooms/:roomId`    | Archive a room: stop its work, keep its conversation         | No      |
| GET    | `/api/teams/:id/onboarding`       | Read the per-team onboarding flags + user-intro text         | No      |
| PATCH  | `/api/teams/:id/onboarding`       | Merge-update the onboarding state                            | No      |
| GET    | `/api/teams/:id/activity-summary` | Compact brief + board + memory + chat snapshot               | No      |
| POST   | `/api/teams/:id/chat`             | Ingest a user message into the server orchestrator (202)     | No      |
| POST   | `/api/teams/:id/chat/stop`        | User Stop: abort in-flight runs, release claimed tasks       | No      |
| POST   | `/api/teams/:id/chat/clear`       | Clear General or one room's chat (messages set aside)        | No      |
| GET    | `/api/teams/:id/chat/stream`      | SSE live-tail of one chat (General or a room)                | SSE     |
| GET    | `/api/team-rules/:teamId`         | Read the durable team-rules text                             | No      |
| PUT    | `/api/team-rules/:teamId`         | Replace the team-rules text (4000-char cap)                  | No      |
| GET    | `/api/team-chat`                  | Cursor-read the team peer-chat room                          | No      |
| POST   | `/api/team-chat/exchange`         | Kick off ONE bounded peer-chat exchange                      | No      |

---

## `GET /api/teams`

Lists every team with a computed `agentCount` (a `COUNT(*)` subquery over `agents.team_id`). Also returns the full agent→team assignment list so a client can patch its fleet store after hydration. Archived teams are excluded unless `includeArchived=true`. Each team also says whether the server orchestrates it (`serverOrchestrated`) and when its General chat was last cleared (`chatClearedAt`); a room's clear time is on the room (see [`GET /api/teams/:id/rooms`](#get-apiteamsidrooms)).

- **Path params**: none.
- **Query params**:

| Param             | Type   | Default | Notes                                               |
| ----------------- | ------ | ------- | --------------------------------------------------- |
| `includeArchived` | string | `false` | `"true"` includes archived teams (`isArchived = 1`) |

- **Request body**: none.

### Responses

**`200 OK`**: the team list plus assignments:

```ts
{
  teams: Array<{
    id: string
    name: string
    icon: string
    color: string
    colorCollectionId: string | null
    templateId: string | null
    leaderAgentId: string | null
    isArchived: number // 0 | 1
    createdAt: number
    updatedAt: number
    agentCount: number // COUNT(*) of agents with this team_id
    serverOrchestrated: boolean // true unless the team opted out (see POST /api/teams/:id/chat)
    chatClearedAt: number | null // when General's chat was last cleared; null = never
  }>
  assignments: Array<{ agentId: string; teamId: string }> // agents with a non-null teamId
}
```

**`500 Internal Server Error`**: any DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/teams
curl 'http://localhost:18790/api/teams?includeArchived=true'
```

---

## `GET /api/teams/member-roles`

The one-line role each live team member states in its SOUL.md, for the board's New task dialog to suggest who fits a sentence (see [Giving an agent a task](/using/board#giving-an-agent-a-task)). Roles are read with the same reader as the team lead's roster: a `- **Role**:` bullet, else the first Role or Mission section, else the intro paragraph. An agent with no role there is left out: OpenClaw agents (their files live on the Gateway), agents with no persona or the shipped default prompt, teamless agents and archived agents.

- **Path params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: roles keyed by agent id:

```ts
{
  roles: Record<string, string> // agentId -> one-line role; agents without one are absent
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/teams/member-roles
```

---

## `POST /api/teams`

Creates a team. The server mints a `crypto.randomUUID()` id unless the body supplies a valid UUID `id`; the create-team UI seeds a client-side id so the Boo color-palette preview matches the deployed team (per-team color rotation is seeded off the team id). `name`, `icon`, and `color` are required; everything else is optional and stored as supplied (`null` when omitted).

- **Path/query params**: none.
- **Request body**:

```ts
{
  name: string               // required
  icon: string               // required (emoji)
  color: string              // required (hex)
  colorCollectionId?: string // null when omitted
  templateId?: string        // null when omitted
  leaderAgentId?: string     // null when omitted
  id?: string                // honored only if it matches the UUID regex; else server-minted
  serverOrchestrated?: boolean // true also writes team-server-orchestrated:<id> = 'true'
}
```

### Responses

**`400 Bad Request`**: body is missing or not an object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: a required field is missing:

```json
{ "error": "name, icon, and color are required" }
```

**`200 OK`**: the created team (note: **200**, not 201):

```ts
{
  team: {
    id: string
    name: string
    icon: string
    color: string
    colorCollectionId: string | null
    templateId: string | null
    leaderAgentId: string | null
    isArchived: 0
    agentCount: 0
    serverOrchestrated: boolean
    createdAt: number
    updatedAt: number
  }
}
```

**`500 Internal Server Error`**: the insert failed:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/teams \
  -H 'Content-Type: application/json' \
  -d '{"name":"Research Squad","icon":"🔬","color":"#34d399"}'
```

---

## `PATCH /api/teams/:id`

Partially updates a team. Only the fields present in the body are written; `updatedAt` is always refreshed. `isArchived` is coerced to `0` or `1` from the body's truthiness. Returns the full updated row (including a recomputed `agentCount`).

- **Path params**: `id` (team id).
- **Request body** (all optional):

```ts
{
  name?: string
  icon?: string
  color?: string
  colorCollectionId?: string | null
  isArchived?: number          // truthy → 1, falsy → 0
  leaderAgentId?: string | null
}
```

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`400 Bad Request`**: the body is missing or not an object:

```json
{ "error": "invalid JSON" }
```

**`404 Not Found`**: no team with that id:

```json
{ "error": "team not found" }
```

**`200 OK`**: the updated team:

```ts
{
  team: {
    id: string
    name: string
    icon: string
    color: string
    colorCollectionId: string | null
    templateId: string | null
    leaderAgentId: string | null
    isArchived: number
    createdAt: number
    updatedAt: number
    agentCount: number
  }
}
```

**`500 Internal Server Error`**: the update failed:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/teams/<team-id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"Renamed","leaderAgentId":"<agent-id>"}'
```

---

## `DELETE /api/teams/:id`

Deletes the team and orphans its agents. In one handler it (1) sets `teamId = null` on every agent in the team, (2) deletes the team-scoped `settings` rows (`team-rules:<teamId>`, `team-onboarding:<teamId>`, and General's clear time `team-chat-cleared:<teamId>`) plus every member's native resume pointer for the team and for each of its rooms, and (3) deletes the team row. The `boo_zero_team_briefs` and `rooms` tables FK-cascade on the team delete (room memberships go with their rooms), so per-team briefs and chat rooms clean themselves.

- **Path params**: `id` (team id).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`200 OK`**: the team was deleted and its agents orphaned:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

<Note>
The handler does not 404 a non-existent team id. `UPDATE … WHERE team_id = ?` and `DELETE … WHERE id = ?` are no-ops when nothing matches, so an unknown id still returns `{ ok: true }`.
</Note>

### Example

```bash
curl -X DELETE http://localhost:18790/api/teams/<team-id>
```

---

## `POST /api/teams/:id/agents`

Assigns an agent to the team. This is an **upsert**: if the agent row does not exist it is created (with `status: 'idle'` and `gatewayId = agentId`); if it exists, only its `teamId` and `updatedAt` are set. The optional `agentName` is used as the display name when creating a new row (it defaults to the `agentId`).

- **Path params**: `id` (team id).
- **Request body**:

```ts
{
  agentId: string     // required
  agentName?: string  // display name when creating a new row; defaults to agentId
}
```

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`400 Bad Request`**: the body is missing/non-object or has no `agentId`:

```json
{ "error": "agentId is required" }
```

**`200 OK`**: the agent was assigned (created or updated):

```json
{ "ok": true }
```

**`500 Internal Server Error`**: the upsert failed:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/teams/<team-id>/agents \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>"}'
```

---

## `DELETE /api/teams/:id/agents/:agentId`

Removes an agent from a team by setting its `teamId` to `null`; the `:id` (team) segment is not used in the predicate. The agent row is not deleted.

- **Path params**: `id` (team id, unused in the query), `agentId` (the agent to orphan).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the `:agentId` segment is missing:

```json
{ "error": "agentId required" }
```

**`200 OK`**: the agent's `teamId` was cleared:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: the update failed:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X DELETE http://localhost:18790/api/teams/<team-id>/agents/<agent-id>
```

---

## `GET /api/teams/:id/rooms`

Lists the team's chat rooms in creation order, oldest first. Archived rooms (the ones deleted in the UI) are not listed, and neither is General: the team's own group chat is the default room and has no row. An unknown team id is not a 404; it returns an empty list. The sidebar applies its own order (pinned rooms first, most recently pinned on top, then newest first).

- **Path params**: `id` (team id).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`200 OK`**: the team's active rooms:

```ts
{
  rooms: Array<{
    id: string
    teamId: string
    name: string
    memberIds: string[] // stored members, oldest membership first; Boo Zero is never stored
    pinnedAt: number | null // when it was pinned to the top of the room list; null = not pinned
    chatClearedAt: number | null // when its chat was last cleared; null = never
    createdAt: number
    updatedAt: number
  }>
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

<Note>
`memberIds` is the stored membership. The room's live roster, the agents its chat lists and routes to, is that list minus any agent that has since been archived or moved to another team (an agent row that is deleted leaves the list by itself), plus Boo Zero, which presides over every room without being stored as a member.
</Note>

### Example

```bash
curl http://localhost:18790/api/teams/<team-id>/rooms
```

---

## `POST /api/teams/:id/rooms`

Creates a chat room from a name and a subset of the team's members, and returns it with **201**. The name has its whitespace collapsed, is trimmed, and is cut to 80 characters. Duplicate member ids count once. Every member must be an active (not archived) agent of this team. Boo Zero needs no membership, because it presides over every room; the default Boo Zero has no team, so its id is refused as a member like any other agent outside the team. A new room starts unpinned and never cleared.

- **Path params**: `id` (team id).
- **Request body**:

```ts
{
  name: string        // required; whitespace collapsed, trimmed, cut to 80 characters
  memberIds: string[] // required; one or more active agents of this team
}
```

### Responses

The checks run in this order:

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`400 Bad Request`**: `name` is missing, not a string, or empty once its whitespace is collapsed:

```json
{ "error": "name required" }
```

**`404 Not Found`**: no team with that id:

```json
{ "error": "team not found" }
```

**`400 Bad Request`**: `memberIds` is missing, not an array, or holds anything other than non-empty strings:

```json
{ "error": "memberIds must be an array of agent ids" }
```

**`400 Bad Request`**: `memberIds` is an empty array:

```json
{ "error": "a room needs at least one member" }
```

**`400 Bad Request`**: one or more ids are not active agents of this team (the message lists them, comma-separated):

```json
{ "error": "not active members of this team: <agent-id>, <agent-id>" }
```

**`201 Created`**: the new room:

```ts
{
  room: {
    id: string
    teamId: string
    name: string
    memberIds: string[] // in the order sent, duplicates dropped
    pinnedAt: null
    chatClearedAt: null
    createdAt: number
    updatedAt: number
  }
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/teams/<team-id>/rooms \
  -H 'Content-Type: application/json' \
  -d '{"name":"Launch prep","memberIds":["<agent-id>","<agent-id>"]}'
```

---

## `PATCH /api/teams/:id/rooms/:roomId`

Changes a room: rename it, replace or add to its members, or pin or unpin it, in any combination. Every field you send is validated before anything is written. `memberIds` replaces the whole member set; the members you keep keep their place in the roster order. `addMemberIds` adds agents and leaves the current members in place, so two adds sent at the same time both land; the dashboard uses it when an agent made on a room's graph joins that room. Send one or the other, not both. A member you remove finishes the turn it is already running, and the room's next turns no longer list or route to it (the roster is read fresh on every turn). Pinning stamps `pinnedAt` with the current time, even on a room that is already pinned, which moves it to the top of the pinned rooms; unpinning clears it.

- **Path params**: `id` (team id), `roomId` (the room).
- **Request body** (at least one field):

```ts
{
  name?: string           // whitespace collapsed, trimmed, cut to 80 characters
  memberIds?: string[]    // replaces the member set; same rules as on create
  addMemberIds?: string[] // adds to the member set; same checks; not with memberIds
  pinned?: boolean        // true pins (pinnedAt = now), false unpins (pinnedAt = null)
}
```

### Responses

The checks run in this order:

**`400 Bad Request`**: a path segment is missing:

```json
{ "error": "team id and room id required" }
```

**`400 Bad Request`**: `pinned` is present but not a boolean:

```json
{ "error": "pinned must be true or false" }
```

**`400 Bad Request`**: both `memberIds` and `addMemberIds` are present:

```json
{ "error": "send memberIds or addMemberIds, not both" }
```

**`400 Bad Request`**: the body has none of `name`, `memberIds`, `addMemberIds`, or `pinned`:

```json
{ "error": "nothing to change" }
```

**`404 Not Found`**: no active room with that id in this team (an archived room, or another team's room, is not found):

```json
{ "error": "room not found" }
```

**`400 Bad Request`**: `name` is present but not a string, or empty once its whitespace is collapsed:

```json
{ "error": "name must not be empty" }
```

**`400 Bad Request`**: `memberIds` is present but invalid, with the same three errors as [`POST /api/teams/:id/rooms`](#post-apiteamsidrooms): `memberIds must be an array of agent ids`, `a room needs at least one member`, or `not active members of this team: <ids>`.

**`400 Bad Request`**: `addMemberIds` is present but invalid: `addMemberIds must be an array of agent ids`, `addMemberIds must name at least one agent`, or `not active members of this team: <ids>`.

**`200 OK`**: the updated room:

```ts
{
  room: {
    id: string
    teamId: string
    name: string
    memberIds: string[]
    pinnedAt: number | null
    chatClearedAt: number | null
    createdAt: number
    updatedAt: number
  }
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/teams/<team-id>/rooms/<room-id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"Launch week","pinned":true}'
```

---

## `DELETE /api/teams/:id/rooms/:roomId`

Archives the room; nothing is deleted. In one call it stops the room's work (a clean Stop, as [`POST /api/teams/:id/chat/stop`](#post-apiteamsidchatstop) does for this `roomId`: claimed tasks are released to `todo` and nothing is reported as a failure), drops the room's resume pointers (`native-team-session:<agentId>:<teamId>:room:<roomId>`) so no agent resumes the archived conversation, and sets the room's `archived_at`. The conversation stays in `chat_messages` under the room's session keys, the room leaves `GET /api/teams/:id/rooms`, and its tasks stay on the board, where a retry or a reassignment runs them from General. No route removes a room row; deleting the team does (the `rooms` table cascades).

- **Path params**: `id` (team id), `roomId` (the room).
- **Request body**: none.

### Responses

**`400 Bad Request`**: a path segment is missing:

```json
{ "error": "team id and room id required" }
```

**`404 Not Found`**: no active room with that id in this team (including one already archived):

```json
{ "error": "room not found" }
```

**`200 OK`**: the room was archived:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X DELETE http://localhost:18790/api/teams/<team-id>/rooms/<room-id>
```

---

## `GET /api/teams/:id/onboarding`

Reads the per-team "Know Your Team" onboarding state. Both `agentsIntroduced` and `userIntroduced` must be true before the normal group-chat composer unlocks. `userIntroText` is the user's self-introduction, the source of truth injected into the team context preamble on every group-chat message. When no row exists, the default `{ false, false, '' }` is returned.

- **Path params**: `id` (team id).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`200 OK`**: the onboarding state (defaults when unset):

```ts
{
  agentsIntroduced: boolean // default false
  userIntroduced: boolean // default false
  userIntroText: string // default ''
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/teams/<team-id>/onboarding
```

---

## `PATCH /api/teams/:id/onboarding`

Merge-updates the onboarding state and returns the full updated state. Only fields with the correct type are applied; a non-boolean `agentsIntroduced`/`userIntroduced` or non-string `userIntroText` is ignored and the current value is kept. `userIntroText` is truncated to 4000 characters.

- **Path params**: `id` (team id).
- **Request body** (all optional, merged with current state):

```ts
{
  agentsIntroduced?: boolean
  userIntroduced?: boolean
  userIntroText?: string   // sliced to 4000 chars server-side
}
```

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`400 Bad Request`**: the body is missing or not an object:

```json
{ "error": "invalid JSON" }
```

**`200 OK`**: the merged, updated state:

```ts
{
  agentsIntroduced: boolean
  userIntroduced: boolean
  userIntroText: string
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/teams/<team-id>/onboarding \
  -H 'Content-Type: application/json' \
  -d '{"agentsIntroduced":true,"userIntroduced":true,"userIntroText":"I run a small SaaS."}'
```

---

## `GET /api/teams/:id/activity-summary`

Builds a compact, on-demand snapshot of what a team has been doing, for injection into Boo Zero's **personal** chat when the user `@`-mentions that team. Composed from durable server state in order (brief, board, saved memory, recent chat), so it works regardless of what the browser has loaded. The sections are sized against a 2500-character budget: the Boo-Zero brief is clipped to 900, the board summary and saved memory are kept whole, and the recent-chat section (up to 30 turns, oldest dropped first) gets whatever budget remains. The recent chat is drawn from General and every active room, since the summary is of the team's work wherever it was discussed.

- **Path params**: `id` (team id).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`200 OK`**: the summary block, or `null` when the team has nothing to report:

```ts
{
  content: string | null // null = no brief, no board tasks, no saved memory, no meaningful chat
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

<Note>
An unknown team id is not a 404: it simply has no brief, board, memory, or chat, so it returns `{ "content": null }`. Saved memory is best-effort (a memory-store failure is swallowed and the section omitted) rather than a 500.
</Note>

### Example

```bash
curl http://localhost:18790/api/teams/<team-id>/activity-summary
```

---

## `POST /api/teams/:id/chat`

Ingests a user message into one chat's **server** orchestrator and returns **202** immediately: General by default, or the room named by `roomId`. Each chat has its own orchestrator, so a cascade started in a room runs beside the others, and the tasks it delegates are filed with that room's id. The cascade proceeds detached: `req.on('close')` is deliberately not wired to abort it, so closing the client (or the request simply ending) never kills the run.

Target resolution happens within that chat's roster (General: the team's active members plus Boo Zero; a room: its live members plus Boo Zero), by priority: an explicit `targetAgentId` that is in the roster, then a **leading** `@`-mention (the message must _start_ with `@<agent name>`, and the name must be followed by whitespace or the end of the message; a mention anywhere else in the text is ignored), then the chat's lead (Boo Zero, else the team's own lead if it is in the roster, else the first member). The user message is persisted under the target's session key for that chat (`agent:<id>:team:<teamId>` in General, `agent:<id>:team:<teamId>:room:<roomId>` in a room) before that agent's turn runs.

The route is gated on the double-orchestration firewall: a team that has opted out via the `team-server-orchestrated:<teamId>` setting (value `'false'`) gets a **404**. Only the literal string `'false'` closes the gate, and nothing writes that value today: an absent key resolves to on, and the one path that writes the key (`POST /api/teams` with `serverOrchestrated: true`) writes `'true'`. So in practice every team is server-orchestrated and the gate passes.

- **Path params**: `id` (team id).
- **Request body**:

```ts
{
  message: string          // required; trimmed, must be non-empty
  targetAgentId?: string   // honored only when it matches a member of the chat's roster
  entryId?: string         // client-minted id for the persisted user entry (SSE dedup)
  roomId?: string          // the chat room to post into; absent or empty = General
}
```

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`400 Bad Request`**: `message` is absent, not a string, or empty after trimming:

```json
{ "error": "message required" }
```

**`404 Not Found`**: the team opted out of server orchestration:

```json
{ "error": "team is not server-orchestrated" }
```

**`404 Not Found`**: `roomId` names no active room of this team (an unknown or archived room, or another team's):

```json
{ "error": "room not found" }
```

**`202 Accepted`**: the message was enqueued (the run has NOT finished):

```json
{ "ok": true }
```

**`500 Internal Server Error`**: an unexpected throw before the enqueue:

```json
{ "error": "<message>" }
```

<Note>
The 202 means "accepted", not "succeeded". Watch the run on `GET /api/teams/:id/chat/stream`. A failed delivery is recovered in place rather than returned here: a down OpenClaw operator connection is reconnected and the same turn retried once, and only a still-failing send is persisted into the transcript as a `role: 'system'`, `kind: 'meta'` entry.
</Note>

### Example

```bash
curl -X POST http://localhost:18790/api/teams/<team-id>/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Plan the launch checklist."}'

# Post into a room instead of General
curl -X POST http://localhost:18790/api/teams/<team-id>/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"@Writer Draft the announcement.","roomId":"<room-id>"}'
```

---

## `POST /api/teams/:id/chat/stop`

User Stop for one chat: General by default, or the room named by `roomId`. Only that chat's orchestrator stops; other rooms keep going. Stop bumps the orchestrator's stop generation **synchronously** (before any await), then aborts every in-flight run through its runtime adapter. In-flight engine work bails at its next checkpoint, and because the generation changed, the resulting aborted terminals are read as a clean Stop rather than a failure: each claimed task is released back to `todo`, with no `blocked` status, no dependent cancellation, and no failure reflection to the delegator. The Stop is made durable in the same call, independently of whether those aborted terminals ever land: queued-but-unsent deliveries are dropped, a delivery already released whose run had not started yet never starts, and every tracked run plus every not-yet-fired ready delegation gets a `cancelled` execution row. That marker is what keeps the board dispatch pump from re-firing the halted cascade. Same server-orchestration gate as the ingest route.

- **Path params**: `id` (team id).
- **Request body** (optional):

```ts
{ roomId?: string } // the chat to stop; absent or empty = General
```

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`404 Not Found`**: the team opted out of server orchestration:

```json
{ "error": "team is not server-orchestrated" }
```

**`200 OK`**: the stop was applied, or there was nothing to stop:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: an unexpected throw:

```json
{ "error": "<message>" }
```

<Note>
Stopping a chat with no live orchestrator (never started this process, or idle-evicted after 30 minutes with no run in flight) is a no-op that still returns `{ "ok": true }`. That includes a `roomId` that names no room at all: unlike the ingest, Stop never answers `room not found`.
</Note>

### Example

```bash
curl -X POST http://localhost:18790/api/teams/<team-id>/chat/stop

# Stop one room; General and the other rooms keep going
curl -X POST http://localhost:18790/api/teams/<team-id>/chat/stop \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"<room-id>"}'
```

---

## `POST /api/teams/:id/chat/clear`

Clears one chat: General by default, or the room named by `roomId`. Nothing is deleted. Each of the chat's `chat_messages` rows is set aside by appending `#cleared:<ts>` to its `session_key` and `entry_id`, so no reader matches it again. The route also drops the resume pointers Clawboo keeps for the chat (the `native-team-session:<agentId>:<teamId>` keys, with `:room:<roomId>` in a room), so native and Codex agents start the conversation fresh on their next turn. It does **not** reset an OpenClaw teammate's session: that conversation lives in the Gateway, not in Clawboo. The clear time is stored in `settings` (`team-chat-cleared:<teamId>` for General, `team-chat-cleared:<teamId>:room:<roomId>` for a room); that is what `chatClearedAt` reports on [`GET /api/teams`](#get-apiteams) and [`GET /api/teams/:id/rooms`](#get-apiteamsidrooms). Other chats are not touched. This route has no server-orchestration gate.

The rows set aside are the ones under the chat's session keys at the moment of the clear: each team member's key in General, each live member's room key in a room, plus Boo Zero's key in either.

<Note>
The UI's **Clear chat** does two things this route does not. First, after the call it sends `/reset` to each of the chat's OpenClaw teammates over the Gateway, exactly as typing `/reset` in the chat does, so in the product every agent starts the conversation fresh. It sends the Gateway's `chat.send` with `message: '/reset'` on each teammate's chat session key (`agent:<id>:team:<teamId>`, with `:room:<roomId>` in a room), only while a Gateway connection is up, skipping any teammate it cannot reach. A direct REST caller gets only the pointer drop. Second, only the chat's timeline stops showing the task cards made before the clear (a task whose `createdAt` is earlier than `chatClearedAt`); the board and the chat's **Tasks** card keep them.
</Note>

- **Path params**: `id` (team id).
- **Request body** (optional):

```ts
{ roomId?: string } // the room to clear; absent or empty = General
```

### Responses

**`400 Bad Request`**: the `:id` segment is missing:

```json
{ "error": "team id required" }
```

**`404 Not Found`**: no team with that id:

```json
{ "error": "team not found" }
```

**`404 Not Found`**: `roomId` names no active room of this team:

```json
{ "error": "room not found" }
```

**`200 OK`**: the chat was cleared:

```ts
{
  ok: true
  clearedAt: number // epoch ms; also the <ts> in the #cleared:<ts> suffix
  cleared: number // how many chat_messages rows were set aside
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
# Clear General
curl -X POST http://localhost:18790/api/teams/<team-id>/chat/clear

# Clear one room
curl -X POST http://localhost:18790/api/teams/<team-id>/chat/clear \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"<room-id>"}'
```

---

## `GET /api/teams/:id/chat/stream`

Server-Sent Events live-tail of one chat's transcript: General by default, or the room named by `roomId`. It runs in two tiers. **Tier 1** polls the durable `chat_messages` rows for that chat's session keys every 750 ms on the monotonic `id` cursor (up to 500 rows per batch); each row's stored `data` is already a serialized `TranscriptEntry` and goes straight to the wire. **Tier 2** forwards ephemeral in-memory signals (assistant token deltas, board-projection changes, agent status) as _named_ frames with no `id:` line, so they never advance the resume cursor.

This is a pure **reader**: the stream never drives orchestration, so a server-side cascade runs to completion with zero clients connected. It is ungated by design (tailing `chat_messages` is safe for any team); the double-orchestration firewall lives on the write path. The session-key set is resolved **once at connect**: in General, `agent:<id>:team:<teamId>` for each team member plus Boo Zero's team-scoped key; in a room, `agent:<id>:team:<teamId>:room:<roomId>` for each live member plus Boo Zero's. A member added mid-stream is picked up on the next reconnect.

- **Path params**: `id` (team id).
- **Query params**:

| Param    | Type   | Notes                                                                                                                                                                                                 |
| -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomId` | string | The chat room to tail; absent or empty = General. A value that is not one of the team's active rooms gets a `404` instead of a stream.                                                                |
| `since`  | number | Resume cursor over the `chat_messages` id; `Last-Event-ID` wins over it. With neither, the stream starts at the newest row and sends only what comes next. A negative or non-numeric value means `0`. |

- **Request body**: none.

<Note>
This is an SSE route, not request/response. Once the stream opens there is no JSON response body; the catalog below describes the wire frames. The one exception comes before it opens: a `roomId` that names no active room of this team (an unknown or archived room, or another team's) gets `404` with `{ "error": "room not found" }`. An unknown team id with no `roomId` is not a 404: no session keys match, so the stream opens and stays open emitting only keepalives. Resume replays **committed rows only**: deltas, board changes, and status frames carry no id and are never replayed.
</Note>

### Connection

On open (after the `roomId` check), the handler writes `HTTP/1.1 200` with:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

then emits a `: connected` comment frame, flushes any rows already past the cursor, and replays the team's last-known agent status per agent.

### Event catalog

| Frame           | When                                                                                                                                  | Shape                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `: connected`   | Immediately on open                                                                                                                   | SSE comment (ignored by `EventSource`)                                                                            |
| _(unnamed)_     | Per committed transcript row (poll every 750 ms)                                                                                      | `id: <row id>` line + `data: <TranscriptEntry json>` line                                                         |
| `event: delta`  | Per live assistant-text delta in this chat                                                                                            | `{ sessionKey, runId, text }`; `text` is the FULL running text so far (replace, not append)                       |
| `event: board`  | Per board mutation on this team, from any write path (the orchestrator, the executor runner, a Tasks MCP tool, the stale sweep, REST) | `{ id, title?, status?, assigneeAgentId?, parentTaskId?, createdAt?, updatedAt?, summary?, attention?, roomId? }` |
| `event: status` | Per run boundary, plus a snapshot on connect                                                                                          | `{ agentId, status: 'running' \| 'idle' \| 'error', roomId? }`                                                    |
| `: keepalive`   | Every 20 s while open                                                                                                                 | SSE comment (keeps the connection warm)                                                                           |

Only the unnamed frames carry an `id:`, so only they move the resume cursor. A client reconciles any board change it missed across a reconnect with a `GET /api/board` reload.

Deltas belong to this chat alone: a stream never forwards another chat's deltas, so General's stream skips every room's, and a room's stream skips General's and the other rooms'. Board and status frames are team-wide, so every stream of the team receives them, each tagged with the chat it came from so a client can keep each chat's task cards and busy state to its own. A board frame's `roomId` is the task's room (`null` = General; left out if the task could not be read), and it carries `attention` (why the task now needs a person, or `null`) only when the change moved the task's status. A run-boundary status frame's `roomId` is the room the run belongs to (`null` = General); the snapshot replayed on connect carries none.

Example frames:

```text
: connected

id: 8121
data: {"entryId":"...","role":"user","kind":"user","text":"Plan the launch checklist.","sessionKey":"agent:<id>:team:<team-id>","runId":null,"source":"local-send","timestampMs":1718450000000,"sequenceKey":1,"confirmed":true,"fingerprint":"..."}

event: status
data: {"agentId":"<agent-id>","status":"running"}

event: delta
data: {"sessionKey":"agent:<id>:team:<team-id>","runId":"<run-id>","text":"Here is the checklist so far"}

: keepalive
```

### Example

```bash
curl -N http://localhost:18790/api/teams/<team-id>/chat/stream

# Resume from a known transcript row id
curl -N 'http://localhost:18790/api/teams/<team-id>/chat/stream?since=8121'

# Tail one room instead of General
curl -N 'http://localhost:18790/api/teams/<team-id>/chat/stream?roomId=<room-id>'
```

---

## `GET /api/team-rules/:teamId`

Reads the durable per-team rules text. The rules are captured either through the maintenance-panel textarea or the `/rule <text>` slash command in the team-chat composer; either path writes here. The text is injected into the message preamble for every team agent so user corrections survive across sessions. When no row exists, `{ content: '' }` is returned.

<Note>
This route uses the param name `:teamId` (not `:id` like the routes above). The value is still the team id.
</Note>

- **Path params**: `teamId` (team id).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the `:teamId` segment is missing:

```json
{ "error": "team id required" }
```

**`200 OK`**: the rules text (empty when unset):

```ts
{
  content: string
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/team-rules/<team-id>
```

---

## `PUT /api/team-rules/:teamId`

Replaces the team-rules text. `content` is required and must be a string; it is rejected (not truncated) when it exceeds 4000 characters. Returns the stored value.

- **Path params**: `teamId` (team id).
- **Request body**:

```ts
{ content?: string }   // required string; max 4000 chars
```

### Responses

**`400 Bad Request`**: the `:teamId` segment is missing:

```json
{ "error": "team id required" }
```

**`400 Bad Request`**: the body is missing or not an object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: `content` is absent or not a string:

```json
{ "error": "content (string) required" }
```

**`400 Bad Request`**: `content` exceeds the 4000-character cap:

```json
{ "error": "content exceeds 4000 characters" }
```

**`200 OK`**: the stored rules:

```ts
{
  content: string
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PUT http://localhost:18790/api/team-rules/<team-id> \
  -H 'Content-Type: application/json' \
  -d '{"content":"Always delegate via <delegate>; never do the work yourself."}'
```

---

## `GET /api/team-chat`

Cursor-reads the team's mixed-runtime peer-chat room, the durable `team_chat` table where every member posts as a named peer. The model-facing write half is the [TeamChat MCP server](/reference/rest-api/tools-and-mcp) at `/api/mcp/teamchat`; this REST route is the UI-facing read. Pass `teamId` (the room resolves to `team:<teamId>`) or a `roomId` directly; one of the two is required. `sinceSeq` is the cursor (posts with `seq > sinceSeq`).

- **Path params**: none.
- **Query params**:

| Param      | Type            | Default             | Notes                                                            |
| ---------- | --------------- | ------------------- | ---------------------------------------------------------------- |
| `teamId`   | string          | n/a                 | Resolves the room id to `team:<teamId>`                          |
| `roomId`   | string          | n/a                 | An explicit room id (overrides `teamId`)                         |
| `sinceSeq` | string (number) | `0`                 | Return posts with `seq > sinceSeq`; non-finite falls back to `0` |
| `limit`    | string (number) | `1000` (data layer) | Cap the batch; ignored if non-finite                             |

- **Request body**: none.

### Responses

**`400 Bad Request`**: neither `teamId` nor `roomId` was supplied:

```json
{ "error": "teamId or roomId is required" }
```

**`200 OK`**: the room posts in ascending `seq` order plus the next cursor:

```ts
{
  roomId: string
  posts: Array<{
    id: string
    roomId: string
    teamId: string
    authorAgentId: string
    body: string
    kind: 'peer' | 'system' | 'user' // 'peer' teammate post · 'system' board-mutation narration · 'user'
    createdAt: number
    seq: number // per-room monotonic
  }>
  nextSeq: number // the last post's seq, or the requested sinceSeq when empty
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/team-chat?teamId=<team-id>&sinceSeq=0'
```

---

## `POST /api/team-chat/exchange`

Kicks off ONE bounded peer-chat exchange for a team: it assembles the team's active members into chat participants, drives a bounded round of turns through the real runtime adapters, and projects the speaker-selection / turn-bound lifecycle into the observability event log. This is a deliberate, invokable trigger, not an autonomous loop. The runtime adapters attach their MCP client to this server's `/api/mcp/*` over a server-trusted loopback URL (never the client `Host`). The exchange is aborted between turns if the initiating request disconnects, and a per-room re-entrancy lock refuses an overlapping exchange.

- **Path/query params**: none.
- **Request body**:

```ts
{
  teamId: string             // required
  stimulus?: string          // the initiating message for the first speaker's turn
  firstSpeakers?: string[]   // agent ids seeded to speak first; defaults to the leader
  maxExchangeTurns?: number  // clamped server-side to DEFAULT_MAX_EXCHANGE_TURNS (5) × participants
}
```

### Responses

**`400 Bad Request`**: missing `teamId`:

```json
{ "error": "teamId is required" }
```

**`409 Conflict`**: an exchange is already running for this room (the per-room lock refuses an overlapping kickoff):

```json
{ "ok": false, "error": "an exchange is already running for this room" }
```

**`200 OK`**: the exchange ran to a bound and returned its result:

```ts
{
  ok: true
  roomId: string
  result: {
    turnsTaken: number
    endedReason: 'max_turns' | 'no_pending_obligation' | 'budget_paused' | 'aborted'
    speakers: string[]   // ordered agent ids who spoke this exchange
  }
}
```

**`404 Not Found`**: the team does not exist (the exchange returned `error: 'team not found'`):

```json
{ "ok": false, "error": "team not found" }
```

**`422 Unprocessable Entity`**: the exchange was refused for any other reason (e.g. `team has no agents`, `unknown first speaker: <id>`, `budget_paused:<scope>`):

```json
{ "ok": false, "error": "<reason>" }
```

**`500 Internal Server Error`**: an unexpected throw:

```json
{ "error": "<message>" }
```

<Info>
The board stays canonical: a peer-chat post never mutates the board. Decisions land as board mutations (see [the board](/concepts/the-board)); the exchange only narrates them into the room as `kind: 'system'` lines.
</Info>

### Example

```bash
curl -X POST http://localhost:18790/api/team-chat/exchange \
  -H 'Content-Type: application/json' \
  -d '{"teamId":"<team-id>","stimulus":"Plan the launch checklist."}'
```

---

## Error envelope

Every error response on these routes is the standard envelope `{ error: string }`. The two exceptions are on `/api/team-chat/exchange`: the **409** re-entrancy refusal and the **404**/**422** exchange-refused branches use `{ ok: false, error: string }` (the success shape is `{ ok: true, roomId, result }`). The SSE route `/api/teams/:id/chat/stream` answers a `roomId` that names no active room with the standard envelope and a `404`, before any stream opens; otherwise it has no error body at all: it commits a `200` event stream up front and swallows transient tail-read errors to keep the connection alive.

## See also

- [Using teams](/using/teams): create, manage leaders, rules, and color collections in the UI
- [Group chat + the Know-Your-Team gate](/using/group-chat): General, rooms, and Clear chat in the UI
- [Mixed-runtime peer chat](/concepts/peer-chat): rooms, speaker selection, `isUser=false`
- [Agents API](/reference/rest-api/agents): the agent registry these team-membership routes reference
- [Tools & MCP API](/reference/rest-api/tools-and-mcp): the TeamChat MCP server (`/api/mcp/teamchat`) write half
- [Database schema](/reference/database-schema): the `teams`, `agents`, `rooms`, `room_members`, `chat_messages`, `settings`, and `team_chat` tables
- [REST API overview](/reference/rest-api/index)
