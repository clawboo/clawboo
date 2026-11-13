---
'clawboo': minor
---

OpenClaw, Claude Code and Codex now install into a folder Clawboo owns instead of npm's global folder, so an install no longer needs `sudo`, no longer fails with a permission error on a system-wide Node, and is not lost when nvm switches Node. The folder is `~/clawboo-runtimes`, or `<CLAWBOO_HOME>-runtimes` when `CLAWBOO_HOME` is set; `CLAWBOO_RUNTIMES_DIR` sets another. Each runtime runs on the Node it was installed with, the OpenClaw Gateway included. An update installs beside the current copy and switches only when it succeeds, so a failed one leaves the runtime as it was. A runtime you installed globally yourself keeps working when Clawboo has none of its own.

OpenClaw's install checks Node first: on a Node outside OpenClaw's range (`>=24.22.1 <25 || >=26.12.1`) it says so and installs nothing, where npm used to install an older OpenClaw without a word. Claude Code now installs from a one-off `npx` run or a source checkout too. OpenClaw's setup also writes its tool sandbox as off, so OpenClaw's tools run on the same computer as your other agents rather than in a Docker container of its own; a sandbox you set up yourself is kept.
