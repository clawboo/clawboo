---
'clawboo': patch
---

Fixes for what happens to a task across a pause, a Stop, a restart and a deleted team.

- Deleting a team now stops its runs, and cancels its open requests with the work under them. Nothing starts its other tasks afterwards, and its folder stays gone. An agent routine stays with its agent and files its tasks with no team, unless it runs a task the team left behind, which now fails instead of running.
- An agent's reply goes on the task when its work check starts, so a restart during the check no longer loses it, and whoever handed out the task is told what it said. If that write fails, the reply goes on when the check ends. `clawboo stop` and a drain now wait for a check under way.
- A run left open on a Blocked task after its process died now ends within minutes, so what waited on it can go on.
- A task update refused because other runs have set aside a budget's room now waits and goes out once there is room, in team chat and in a one-to-one chat, instead of being given up after a few tries, and the chat says it goes out by itself.
- A task failing or being moved no longer cancels a person's message waiting on the same agent. A message of yours that never starts now says so in the chat.
- A Stop now holds every task update still waiting, including ones a later sweep would have sent.
- A pause keeps what a task's check found and how many fix rounds it has had, so the count no longer starts over on resume. A Stop also forgets what an ended round was told.
- A hand-off refused because its request has closed now says so in the chat, and the agent that asked reads it on its next turn.
- A comment you write on a paused task whose agent asked a question now starts the task on resume, as it does with no pause.
