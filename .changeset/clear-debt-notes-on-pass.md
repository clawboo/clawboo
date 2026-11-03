---
'clawboo': patch
---

A task that passes its check no longer keeps the open issues from an earlier pass with debt. Before, a task that passed with debt, went back to In progress and then passed cleanly still listed the old issues in `GET /api/board/:taskId`, in the Tasks MCP tools and to agents reading the task, though the task drawer already hid them. A failed check still keeps the open issues, because it has not shown they are fixed, and a second pass with debt adds its issues to the earlier ones. Each attempt's own result is kept as before. A task checked before this update keeps its old list until it is checked again.
