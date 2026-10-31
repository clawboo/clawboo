---
title: 'Chat history API'
sidebarTitle: 'Chat history'
description: "REST reference for stored chat transcripts: read a session page by page, save entries, reset an agent's context, and delete a session."
keywords: ['misc', 'chat-history', 'transcript', 'reset context', '/reset', 'chat_messages']
---

Stored chat transcripts, one session at a time. The server stores most chat turns here itself as they happen, the dashboard also saves entries through `POST`, and it reads a chat back a page at a time. Use this page when you read or archive conversations outside the dashboard.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. All four routes are on the general rate limit described in the [REST API overview](/reference/rest-api/index). Errors use `{ "error": "<message>" }`.

## Routes

| Method | Path                              | Summary                                                    |
| ------ | --------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/chat-history`               | Read the newest page of a session, with a cursor for older |
| POST   | `/api/chat-history`               | Save transcript entries (repeats are ignored)              |
| POST   | `/api/chat-history/reset-context` | End the agent's conversation and add a divider             |
| DELETE | `/api/chat-history`               | Delete every message of a session                          |

## Sessions and entries

Each stored row belongs to one **session key**. The keys the server reads for itself:

| Session key                                   | Conversation                                    |
| --------------------------------------------- | ----------------------------------------------- |
| `agent:<agentId>:native`                      | A Clawboo Native agent's 1:1 chat               |
| `agent:<agentId>:<runtime>`                   | A Claude Code, Codex or Hermes agent's 1:1 chat |
| `agent:<agentId>:team:<teamId>`               | One teammate's session in a team's General chat |
| `agent:<agentId>:team:<teamId>:room:<roomId>` | The same, in one of the team's rooms            |

Other chats, such as an OpenClaw agent's 1:1 chat, use the session key the dashboard already holds for them.

Each row stores one transcript entry as JSON:

```ts
interface TranscriptEntry {
  entryId: string // unique; a repeat is ignored on save
  role: 'user' | 'assistant' | 'tool' | 'system' | 'other'
  kind: 'meta' | 'user' | 'assistant' | 'thinking' | 'tool'
  text: string
  sessionKey: string
  runId: string | null
  source: 'local-send' | 'runtime-chat' | 'runtime-agent' | 'history' | 'legacy'
  timestampMs: number | null
  sequenceKey: number
  confirmed: boolean
  fingerprint: string // an opaque id, not a content hash
  origin?: { kind: 'routine'; routineId: string; routineName: string } // posted by a routine
}
```

### Three ways a conversation ends

| Action                                         | Route                                  | Messages                                                                        |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| **Reset context** (`/reset` or `/new` in chat) | `POST /api/chat-history/reset-context` | Kept, with a divider at the reset point                                         |
| **Clear chat** in a team's chat                | `POST /api/teams/:id/chat/clear`       | Set aside: re-keyed with a `#cleared:<ts>` suffix, so no read here returns them |
| **Delete** (when an agent is deleted)          | `DELETE /api/chat-history`             | Deleted                                                                         |

All three also clear the saved resume points of the sessions involved. A resume point is the saved session an agent continues from on its next turn. Clawboo Native, Claude Code, Codex and Hermes agents keep one for a 1:1 chat, and Clawboo Native and Codex team leaders keep one per team chat. Clear chat is documented in the [Teams API](/reference/rest-api/teams).

## `GET /api/chat-history`

Returns the **newest** page of a session, oldest first within the page. Pass `nextBefore` back as `before` to walk further back. Rows whose stored JSON cannot be parsed are left out.

- **Query params**:

| Param        | Type   | Default  | Notes                                                                                               |
| ------------ | ------ | -------- | --------------------------------------------------------------------------------------------------- |
| `sessionKey` | string | required | The session to read                                                                                 |
| `limit`      | number | `200`    | At most `1000`; a non-numeric value falls back to `200`                                             |
| `before`     | number | none     | A row id, normally `nextBefore` from an earlier response; a value that is not an integer is ignored |

### Responses

**`200 OK`**:

```ts
{
  entries: TranscriptEntry[]
  hasMore: boolean // older entries exist
  nextBefore: number | null // pass back as `before`; null at the start of the session
}
```

**`400 Bad Request`**: no `sessionKey`:

```json
{ "error": "sessionKey required" }
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

### Example

```bash
curl "http://localhost:18790/api/chat-history?sessionKey=agent:my-boo:native&limit=500"
```

## `POST /api/chat-history`

Saves transcript entries for one session. Saving is idempotent: an entry whose `entryId` is already stored is ignored, and an entry with no `entryId` is skipped.

- **Request body**:

```ts
{
  sessionKey: string // required
  gatewayUrl?: string // stored on each row; defaults to ''
  entries: TranscriptEntry[] // required, at least one
}
```

Each entry is stored exactly as sent. When it has no `timestampMs`, only the row's own timestamp column gets the time it arrived; the entry that `GET` returns is unchanged.

### Responses

**`200 OK`**: `saved` counts the entries received, not the rows written:

```ts
{ ok: true, saved: number }
```

**`400 Bad Request`**: the body is not a JSON object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: no `sessionKey`, or `entries` is not a non-empty array:

```json
{ "error": "sessionKey and entries[] required" }
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

### Example

```bash
curl -X POST http://localhost:18790/api/chat-history \
  -H 'Content-Type: application/json' \
  -d '{"sessionKey":"agent:my-boo:native","entries":[{"entryId":"e1","role":"user","kind":"user","text":"Hi","sessionKey":"agent:my-boo:native","runId":null,"source":"local-send","timestampMs":1761650000000,"sequenceKey":1761650000000,"confirmed":true,"fingerprint":"e1"}]}'
```

## `POST /api/chat-history/reset-context`

Writes one divider entry and clears the saved resume point of every listed session, so an agent that resumes from one (see above) starts its next turn fresh. **No message is moved, re-keyed or deleted.** This is what `/reset` and `/new` call. The route does not reach the OpenClaw Gateway: for an OpenClaw agent, the dashboard also sends `/reset` to the agent's Gateway session.

A team chat passes every teammate's session key plus one `noticeSessionKey`, so the person sees one divider in the merged timeline rather than one per teammate.

- **Request body**:

```ts
{
  sessionKeys: string[] // required; empty strings are ignored
  noticeSessionKey?: string // must be one of sessionKeys; defaults to the first
}
```

### Responses

**`200 OK`**: the divider that was written, ready to show:

```ts
{ ok: true, entry: TranscriptEntry } // kind 'meta', role 'system'
```

**`400 Bad Request`**: no usable session key:

```json
{ "error": "sessionKeys[] required" }
```

**`400 Bad Request`**: `noticeSessionKey` is not in the list:

```json
{ "error": "noticeSessionKey must be one of sessionKeys" }
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

### Example

```bash
curl -X POST http://localhost:18790/api/chat-history/reset-context \
  -H 'Content-Type: application/json' \
  -d '{"sessionKeys":["agent:my-boo:native"]}'
```

## `DELETE /api/chat-history`

Deletes every message of one session and clears its resume point. The dashboard calls this when it deletes an agent. To end a conversation and keep the messages, use reset-context instead.

- **Query params**: `sessionKey` (required).

### Responses

**`200 OK`**:

```json
{ "ok": true }
```

**`400 Bad Request`**: no `sessionKey`:

```json
{ "error": "sessionKey required" }
```

**`500 Internal Server Error`**: a database failure, `{ "error": "<message>" }`.

### Example

```bash
curl -X DELETE "http://localhost:18790/api/chat-history?sessionKey=agent:my-boo:native"
```

**Source of truth:** `apps/web/server/api/chatHistory.ts`; the entry type is `TranscriptEntry` in `packages/protocol/src/index.ts`.

## Related

- [Team chat](/using/team-chat): General, rooms, Clear chat and `/reset` in the dashboard
- [Teams API](/reference/rest-api/teams): Clear chat, stop, and the team chat stream
- [Agents API](/reference/rest-api/agents): 1:1 chat with a Clawboo Native, Claude Code, Codex or Hermes agent and its live stream
- [Database schema](/reference/database-schema): the `chat_messages` table
