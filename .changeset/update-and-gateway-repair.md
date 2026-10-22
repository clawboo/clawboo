---
'clawboo': patch
---

Updating from the dashboard keeps working after the first update, and the OpenClaw Gateway starts again after an OpenClaw upgrade without a trip to the terminal.

**Updates.** The dashboard server used to run inside Clawboo's own install folder, which `npm install -g clawboo@latest` replaces. After one update from the "Click to update" chip, the server and everything it started sat in a folder that no longer existed: the next update failed with "exit code 7", the OpenClaw Gateway could not be started, and the restart into the new version never came up. The server now runs in `~/.clawboo`, and a server that does start in a deleted folder moves to a valid one before it loads anything else, so the restart after an update comes up on the new version. Updating from 0.5.0 benefits too: the old version's update starts the new one, which recovers by itself.

When an update fails, the chip now shows npm's own reason (a missing version, a network failure, a permission problem, a package whose install script failed) instead of only an exit code.

**OpenClaw Gateway.** A newer OpenClaw can refuse to start until `openclaw doctor --fix` migrates data an older version wrote. When Clawboo starts the Gateway and OpenClaw asks for that, Clawboo runs `openclaw doctor --fix --non-interactive` once and starts the Gateway again, leaving any launchd or systemd Gateway service alone. A Gateway that fails to start for another stated reason now reports that reason at once instead of after a 60-second wait.
