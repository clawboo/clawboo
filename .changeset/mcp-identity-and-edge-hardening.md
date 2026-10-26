---
'clawboo': patch
---

Close two identity gaps in the MCP servers and harden the server's HTTP edge.

**TeamChat no longer takes an author from tool arguments over HTTP.** A TeamChat session without a signed room-and-author binding used to accept `authorAgentId`, `teamId` and `roomId` from the model, so it could read any team's room and post into it as any agent. The verification critic and any run for a task without a team attach exactly that way. Such a session is now served no TeamChat tools, the same rule Tasks and Memory already apply to an unidentified caller. Runs with a team keep their bound tools, and the TeamChat stdio bin, where the operator is the caller, still takes identity from its arguments.

**`create_subtask` checks the team.** On a session bound to a team, a parent task from another team is now refused with the same "not found" a read gets. Before, the new subtask inherited the other team, the cross-team write that `create_task` already refused.

**The API routes match case exactly.** `/API/settings` and other case variants no longer reach the lowercase routes. The access gate already folded case, so nothing got past it, but the router now agrees with it.

**A warning for a proxy with no token.** With `STUDIO_ACCESS_TOKEN` unset, the server now logs a one-time `SECURITY:` warning when a request arrives through a reverse proxy, since everything behind that proxy is then reachable without a credential. It never blocks a request.
