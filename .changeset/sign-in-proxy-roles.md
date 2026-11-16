---
'clawboo': minor
---

Behind a sign-in proxy, the role in each person's identity token can now decide what they may do. Set `proxyIdentityRoles` to `enforce` (or `CLAWBOO_PROXY_IDENTITY_ROLES=enforce`) together with `proxyIdentity: required`, and every API route checks the role your proxy names:

- an `owner` sees and does the work, answers approvals, and alone may answer one with "Allow always";
- an `operator` sets up and runs the install (agents, teams, routines, connectors, providers, settings and costs) but never answers an approval;
- a `member` sees and does the work, and answers approvals only when the token says `"approve": true`;
- a `guest` reaches only the teams the token's `teams` claim lists, and only until its `access_until`, which a guest's token must carry; a stream a guest has open closes then too.

Roles add up, and a route nobody listed is the operator's. The Gateway WebSocket (whose OpenClaw commands include answering approvals), the settings that decide whether agents ask (an agent's command posture, OpenClaw's own settings) and pairing a device with the Gateway need a person who is both owner and operator; turning a team's plan approval off, or letting its agents wake each other without asking, needs the owner. An operator sets up the programs Clawboo runs, so give that role only to people you trust with the server. A token marked `svc: true` is a program's, such as the sign-in front's own scheduler: it gets its role's permissions but is never a person and never answers an approval. An `rv` claim names the version of these claims, and a version Clawboo does not know is refused. A request the role does not allow gets `403` with `"error": "role"` and a reason. `GET /api/access/identity` says whether roles are enforced and what the person may do, and the new `auth.roles` capability flag says the server enforces them. Roles are off by default: without the setting, a role is only recorded, as before. With or without roles, a task that waits on or depends on a task of another team no longer copies that task's title into its own comments, its waiting reason or its team's room.
