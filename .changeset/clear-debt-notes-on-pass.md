---
'clawboo': patch
---

A task that passes its check with a completed review no longer keeps the open issues from an earlier pass with debt. Before, a task that passed with debt, went back to In progress and then passed cleanly still listed the old issues in `GET /api/board/:taskId`, in the Tasks MCP tools and to agents reading the task, though the task drawer already hid them. A pass whose review was skipped, returned nothing or did not complete keeps the reviewer's issues, because nobody looked at them again, and drops only the issue a failed test command left. A failed check still keeps the open issues, and a second pass with debt adds its issues to the earlier ones. Each attempt's own result is kept as before. A task checked before this update keeps its old list until it is checked again.
