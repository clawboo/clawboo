---
'clawboo': patch
---

The task drawer now shows the open issues a passing check did not look at again. When a task passed with debt, went back to In progress and then passed a check whose review was skipped, returned nothing or did not complete, its open issues stay on the result, and `GET /api/board/:taskId` and agents already saw them. The drawer hid them. Its Verification section now lists them under **Passed**, marked **Not reviewed again**. A pass whose review completed still lists none, and the issue a failed test command left never shows on a pass, since the command passed. A failed check also keeps the open issues, and the drawer now lists them under the failure, marked **Still open from an earlier pass with debt**. There the failed command's issue shows only while the latest command still fails.
