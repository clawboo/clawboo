---
'clawboo': minor
---

Agents wake when something happens on their task. A person's comment and a dependency moving to done save a durable wake, one per agent and task, that survives a restart and starts the right run exactly once; a comment arriving during a run reaches the agent at its next turn, once. Every run is stamped on its task's claim, and a task that keeps running with no visible progress waits before it starts again by itself. After a Stop, a report-up or a wake is no longer dropped: it starts nothing, and rides the next run that comes.
