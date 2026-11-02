---
title: 'Boo Zero API'
sidebarTitle: 'Boo Zero'
description: "REST reference for Boo Zero's team briefs and display name, and the override that picks which agent is Boo Zero."
keywords: ['misc', 'boo zero', 'team brief', 'global brief', 'display name', 'leader override']
---

Boo Zero is your team leader: one agent that coordinates every team. These routes store the team briefs written for it, a display name the dashboard shows for it, and the override that decides which agent is Boo Zero. Use this page when you script team setup or move the leader role to another agent.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. All seven routes are on the general rate limit described in the [REST API overview](/reference/rest-api/index). Errors use `{ "error": "<message>" }`.

## Routes

| Method | Path                                  | Summary                                                     |
| ------ | ------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/boo-zero/team-briefs/:teamId`   | Read a team's brief                                         |
| PUT    | `/api/boo-zero/team-briefs/:teamId`   | Save a team's brief                                         |
| DELETE | `/api/boo-zero/team-briefs/:teamId`   | Remove a team's brief                                       |
| GET    | `/api/boo-zero/display-name/:agentId` | Read the display name saved for an agent                    |
| PUT    | `/api/boo-zero/display-name/:agentId` | Save or clear that display name                             |
| GET    | `/api/boo-zero/override`              | Read the leader override and the agent that is Boo Zero now |
| POST   | `/api/boo-zero/override`              | Make any agent Boo Zero, or clear the override              |

## Briefs

A brief is markdown. A missing brief reads as `content: null`, not as a `404`; the dashboard then shows a generated default.

| Brief | Stored in                                               | Where it reaches a model                                                                                    |
| ----- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Team  | The `boo_zero_team_briefs` table, deleted with the team | Only in Boo Zero's 1:1 chat, when a message starts with `@TeamName`: the brief rides in that team's summary |

The dashboard edits the team brief from the team chat's settings sheet; see [Boo Zero](/using/boo-zero).

There is no global brief. `GET` and `PUT /api/boo-zero/global-brief` were removed, so they answer like any unknown path: `404`, except that in a built app a `GET` returns the dashboard page (see [Requests and responses](/reference/rest-api/index#requests-and-responses)). A global brief an older version saved stays in the `settings` table under the key `boo-zero:global-brief`, and nothing reads it. Guidance Boo Zero must follow in a team belongs in that team's rules (`PUT /api/team-rules/:teamId` on the [Teams API](/reference/rest-api/teams)), which are read on every turn.

### `GET /api/boo-zero/team-briefs/:teamId`

#### Responses

**`200 OK`**: the stored brief, or `null`s when there is none:

```ts
{ content: string | null, updatedAt: number | null }
```

**`400 Bad Request`**: `{ "error": "teamId required" }`.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/boo-zero/team-briefs/<team-id>
```

### `PUT /api/boo-zero/team-briefs/:teamId`

Creates or replaces the team's brief.

- **Request body**: `{ "content": string }` (required).

#### Responses

**`200 OK`**:

```ts
{ content: string, updatedAt: number }
```

**`400 Bad Request`**: `{ "error": "teamId required" }`, or `{ "error": "content (string) required" }` when `content` is missing or not a string.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`. A `teamId` that names no team fails here too, because a brief must belong to a team.

#### Example

```bash
curl -X PUT http://localhost:18790/api/boo-zero/team-briefs/<team-id> \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Growth team\n\nShip the launch post by Friday."}'
```

### `DELETE /api/boo-zero/team-briefs/:teamId`

Removes the team's brief. Removing a brief that does not exist still answers `200`. Deleting the team removes its brief too.

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`400 Bad Request`**: `{ "error": "teamId required" }`.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl -X DELETE http://localhost:18790/api/boo-zero/team-briefs/<team-id>
```

## Display name

A name the dashboard shows for Boo Zero instead of the agent's own name, saved per agent id in the `settings` table (key `boo-zero:display-name:<agentId>`). It is removed when the agent is deleted.

### `GET /api/boo-zero/display-name/:agentId`

#### Responses

**`200 OK`**: the saved name, or `null` when none was ever saved. A cleared name reads as `""`; treat an empty name as unset:

```ts
{
  name: string | null
}
```

**`400 Bad Request`**: `{ "error": "agentId required" }`.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/boo-zero/display-name/<agent-id>
```

### `PUT /api/boo-zero/display-name/:agentId`

Saves the name, trimmed and cut to 80 characters. An empty string clears it.

- **Request body**: `{ "name": string }` (required).

#### Responses

**`200 OK`**: the value actually stored:

```ts
{
  name: string
}
```

**`400 Bad Request`**: `{ "error": "agentId required" }`, or `{ "error": "name (string) required" }` when `name` is missing or not a string.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl -X PUT http://localhost:18790/api/boo-zero/display-name/<agent-id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"Boo Zero"}'
```

## Leader override

Clawboo picks Boo Zero in this order:

1. **The override**: an agent you named with `POST /api/boo-zero/override`, on any runtime, if it still exists and is not archived.
2. **Clawboo Native's Boo Zero**: the team-less Boo Zero agent Clawboo creates on Clawboo Native once a team has a Clawboo Native member.
3. **The OpenClaw default**: among OpenClaw agents with no team, the Gateway's default agent if it is one of them, else the first of them.

The dashboard has no control for the override. It sets one in a single case: when you deploy a team on Codex and neither an override nor a Clawboo Native Boo Zero exists, the team's lead becomes the override.

### `GET /api/boo-zero/override`

#### Responses

**`200 OK`**:

```ts
{
  overrideAgentId: string | null // null when unset or cleared
  effective: { id: string; name: string } | null // the agent that is Boo Zero now
  tier: 'override' | 'native' | 'openclaw' | null // which rule picked it
}
```

`tier` reads `override` whenever an override is saved, even when that agent cannot be resolved (it was deleted or archived) and `effective` has fallen through to the next rule.

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/boo-zero/override
```

### `POST /api/boo-zero/override`

Sets or clears the override. Any runtime is allowed. The agent must exist and not be archived; clearing restores the order above.

- **Request body**: `{ "agentId": string | null }` (required: a non-empty string to set, `null` to clear).

#### Responses

**`200 OK`**: saved, with the agent that is Boo Zero after the change:

```ts
{
  ok: true
  overrideAgentId: string | null
  effective: { id: string; name: string } | null
}
```

**`400 Bad Request`**: the body has no `agentId` key:

```json
{ "error": "agentId is required (string to set, null to clear)" }
```

**`400 Bad Request`**: `agentId` is neither `null` nor a non-empty string:

```json
{ "error": "agentId must be a non-empty string or null" }
```

**`404 Not Found`**: no live agent has that id:

```json
{ "error": "agent not found (or archived)" }
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

#### Example

```bash
# Make an agent on any runtime Boo Zero
curl -X POST http://localhost:18790/api/boo-zero/override \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>"}'

# Clear the override
curl -X POST http://localhost:18790/api/boo-zero/override \
  -H 'Content-Type: application/json' \
  -d '{"agentId":null}'
```

**Source of truth:** `apps/web/server/api/booZero.ts`, `apps/web/server/api/booZeroOverride.ts`, and the resolution order in `apps/web/server/lib/teamChat/booZero.ts`.

## Related

- [Boo Zero](/using/boo-zero): where the dashboard edits the display name, and when Boo Zero reads a team's brief
- [Teams API](/reference/rest-api/teams): team rules, rooms, and the team activity summary
- [Agents API](/reference/rest-api/agents): `defaultId` in `GET /api/agents` is the agent this page calls Boo Zero
- [Agent model](/concepts/agent-model): Boo Zero and a team's own Leader
