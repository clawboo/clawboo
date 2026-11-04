---
'clawboo': patch
---

A check whose test command passes no longer keeps an earlier "test command failed" issue when its reviewer fails the work. Before, a task that passed with debt because its command failed, went back to In progress, then ran the command green but had the reviewer block it, still listed the old command failure in `GET /api/board/:taskId`, in the Tasks MCP tools and to agents reading the task. When that was the last attempt, the result was a pass with debt and the task drawer showed the stale failure too. The reviewer's issues, earlier and new, are kept as before, and a failed command still keeps every issue. A task checked before this update keeps its old list until it is checked again.
