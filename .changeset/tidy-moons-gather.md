---
'clawboo': minor
---

Add the grant spine: one row that is both the permission the tool broker enforces and the edge the
Ghost Graph draws.

Three tables (`connectors`, `capability_grants`, `approval_rules`) and a repository in
`@clawboo/db`. A connector tile can now be dragged onto a second Boo to share it, and detached to
revoke, backed by real `/api/grants` routes rather than an endpoint the UI hoped existed.

The coupling is the point. The badge on a tile is not a second reading of a status column: the
graph and the broker call the same `decideGrant`, over the same candidate rows, keyed the same way.
An expired grant whose row has not been swept yet renders as expired, because that is what the
runtime would do with it.

What the gate governs is narrow and deliberate. Core builtins are clawboo's own verbs and stay
ungoverned; a grant that could revoke them would be a switch for turning the product off. Every
tool a connector supplies goes through the gate from the moment that connector is connected, so
connecting one is also the act that puts it under governance.
