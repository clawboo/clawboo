---
'clawboo': minor
---

Restore archived teams and move agents between teams from the dashboard.

**Archived teams.** The team rail ends with an **Archived** group listing archived teams, which were otherwise shown nowhere. Click one and choose **Unarchive** to bring it back.

**Move to team.** Right-click an agent on the Org chart or a team graph and choose **Move to team**. The move happens in one step through the new `POST /api/agents/:agentId/move`: the agent's own routines go with it, tasks it has not started stay on the old team's board unassigned instead of firing at an agent that left, and its old rooms and session state are cleared. A team's lead, Boo Zero and an agent with a task in progress cannot be moved.
