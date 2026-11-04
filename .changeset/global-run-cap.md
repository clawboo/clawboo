---
'clawboo': patch
---

Clawboo now caps how many agent runs execute at once across the whole server, 8 by default; set `CLAWBOO_MAX_CONCURRENT_RUNS` to change it. Board tasks, team chat turns and the tasks they hand out, one-to-one chat, peer exchanges and Routine runs all count. A run that arrives while every slot is busy waits its turn instead of starting at once: it is never failed for waiting, the idle watchdogs do not count the wait, and **Stop** takes it out of the queue. A run whose agent is already busy waits without holding a slot, so one agent's backlog never blocks the others. Routines that fall due together now start as slots free up rather than all at once.
