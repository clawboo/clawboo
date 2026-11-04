---
'clawboo': minor
---

Team chat work is now checked like the task runner's. On a team with a work check (the command you set in the team's settings, such as `npm test`), a task handed off in team chat, or given to an agent on the Board, that changed the team's folder is done only once that command passes in the folder. A large or risky change, or work a teammate handed down from its own task, also gets the same independent reviewer the task runner uses. A failed check sends the task back to its agent with what failed, once by default, and then to Needs you; whoever handed the task off hears about it only after the check.

Clawboo sees what a task changed through a history of the team's folder that it keeps outside the folder, in `~/.clawboo/team-folder-history/`, so the folder never becomes a git checkout. The check runs on the whole folder, so it also covers what a teammate changed there at the same time. Without a work check, team chat work stays unchecked, and OpenClaw agents, which work outside the team's folder, are not checked.
