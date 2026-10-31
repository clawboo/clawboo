---
'clawboo': patch
---

Team chat runs, and task runs that only read (research and review, routines included), now start in a folder of their team instead of Clawboo's own data folder. This covers Claude Code, Codex, Hermes and Clawboo Native agents. Each team gets one folder, `~/.clawboo/workspaces/<team id>` (under `CLAWBOO_HOME` when that is set), created so only your user can open it and shared by every member and every room of the team, so a file one teammate writes is where the next one looks. A read-only task with no team uses `~/.clawboo/workspaces/_no-team`. Before this, Claude Code, Codex and Hermes started these runs in the folder that holds Clawboo's database and saved keys. If the folder cannot be created, the run does not start.

For Claude Code, Codex and Hermes this changes only the folder they start in: they still run with your full file access and with their own permission prompts off, as before. Clawboo Native agents now have their file tools (read, write and list files) in team chat and on read-only tasks, kept inside the team folder. Their file tools also no longer follow a symlink out of the folder they work in. A Native agent can run commands only if you switched that on for it, and it asks you before every command. OpenClaw agents are unchanged, and task runs that change files still work in their own copy of the repository.

An agent's Workspace tab now shows its team folder, read-only, beside any task worktrees, so you can open the files your agents saved there. Deleting a team deletes its folder and those files too, and the delete confirmation says so when the team has an agent that works in it. Archiving a team keeps the folder.
