---
'clawboo': patch
---

An approval nobody answers is now closed as soon as Clawboo stops waiting for it. When a connector call, Clawboo Native command or risky hand-off runs out of time, Clawboo marks the request expired and writes `approval_resolved` with the decision `expired` right away. Before, the request stayed pending for up to 25 hours, until the hourly cleanup found it. In that time the event log heard nothing, and the agent's link to the connector on the graph stayed amber as if a call were still waiting. An answer that arrives after a request's time is up is now refused with `409 approval expired` instead of being recorded, so a late **Always** no longer saves a rule for a call that never ran. The graph and the `pendingApprovals` count in `GET /api/capabilities` now count only requests that can still be answered.
