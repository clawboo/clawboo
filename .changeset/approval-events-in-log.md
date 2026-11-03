---
'clawboo': patch
---

Approvals now show up in the event log. Every approval card writes an `approval_requested` event when it opens and an `approval_resolved` event when it is answered or expires. This covers connector calls, Clawboo Native commands, risky hand-offs and OpenClaw commands. Before, nothing wrote `approval_requested`, and `approval_resolved` was written only when the hourly cleanup expired a request nobody had answered. A person's answer never reached the log, so the **Activity** feeds and anything reading `GET /api/obs/events` could not see an approval waiting or being answered. The events name the tool and never carry its arguments or the command text. The **Activity** feed now labels each approval row with its tool's name.
