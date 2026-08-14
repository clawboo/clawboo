---
'clawboo': patch
---

Board statuses and the legal-transition table now come from one shared module (`@clawboo/board-core`) instead of four hand-maintained copies, so the board UI can no longer drift from the transitions the server enforces. The group-chat task card derives its status pill from the same module: a task with an off-list status now shows its raw status name instead of being mislabelled "Queued".
