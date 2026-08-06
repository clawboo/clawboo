---
'clawboo': patch
---

Cap subtask creation at the Tasks MCP boundary: `create_subtask` (and `create_task` with a `parentTaskId`) now return a tool error once a parent has 24 live children or the task would nest more than 2 levels deep, and an unknown or empty parent id returns a tool error instead of failing the tool call with a protocol error. The check and the insert share one transaction, so two attached runtimes racing the same parent cannot both slip past the ceiling. A parented `create_task` now inherits the parent's team. A dependency cycle over the REST board API returns 409 instead of 500, and the ancestor-chain walk now terminates instead of hanging if a database has a corrupt parent cycle.
