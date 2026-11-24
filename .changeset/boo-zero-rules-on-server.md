---
'clawboo': patch
---

When the server runs Boo Zero's one-to-one chat (Clawboo Native, Claude Code, Codex and Hermes), the server now writes Boo Zero's rules into each turn, instead of the dashboard.

- A program that posts to Boo Zero with `POST /api/agents/:agentId/chat` sends the person's words and, for an `@Team` message, that team's `teamId`. The server adds Boo Zero's rules and what the team has been doing, so every client gets the same turn as the dashboard.
- The server knows when a turn carries what a team has been doing, which limits the teams it can hand work to. Words a person types that only look like a team's activity no longer limit it.
- A dashboard tab left open from before the update keeps working for this release: a message that already carries Boo Zero's rules gets no second set.
