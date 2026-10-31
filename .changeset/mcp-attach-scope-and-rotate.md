---
'clawboo': patch
---

`GET /api/mcp/config` checks the identity it signs, and the attach secret can be replaced without a restart. The route answers `400` with `unknown team: <id>` when `scopeTeamId` names no team, and `agent <id> is not on team <team>` when `scopeAgentId` is a Clawboo agent from another team. An id no Clawboo agent uses is still signed as given, for an outside agent's own identity. New `POST /api/mcp/attach-secret/rotate` (access cookie required while the gate is on) replaces the secret behind every `attachToken`, `scopeSig` and `provSig`: every URL minted before stops verifying, Clawboo's runtimes get new URLs on their next run, and a connected local OpenClaw Gateway gets its new URLs at once. It replaces the documented `sqlite3 ... DELETE FROM settings` recipe.
