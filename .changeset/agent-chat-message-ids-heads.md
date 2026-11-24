---
'clawboo': patch
---

A program that posts into an agent's one-to-one chat, such as a script, a bot bridge or a second app, can now send each message once and tell which rows answer it.

- `POST /api/agents/:agentId/chat` starts one turn per `entryId`, ever. Sending the same id to the same chat again stores nothing, starts no turn and answers `202` with `"duplicate": true`, so retrying after a dropped connection is safe. To try again after a turn failed, send a new id. An id another chat already holds answers `409` with `"error": "entry_id_in_use"`. Before, that message was dropped and its turn still ran. Every `202` now returns the message's `entryId`, including the one the server makes when you send none.
- The reply and every notice of a message's turn (a paused agent, a budget, a failed run, a turn too large for the model, a busy agent, a hand-off that did not start) carry `inReplyTo`, that message's `entryId`. Two messages waiting for one agent are not always answered in the order they came, so this is how to match a reply to its message. Turns Clawboo starts by itself, such as Boo Zero reading results a team sent back, carry none.
- `GET /api/agents/chat/heads?agents=a,b` answers the newest row id of each chat, `{ "heads": { "<agentId>": <rowId> } }`, for agents whose chat the server runs (Clawboo Native, Claude Code, Codex and Hermes). Open that chat's stream with `?since=<head>` to get exactly what comes after it. Without `agents` it lists every such agent that is not archived. It takes up to 200 ids.
