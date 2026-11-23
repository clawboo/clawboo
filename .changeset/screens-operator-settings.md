---
'clawboo': minor
---

Settings for anyone who runs Clawboo for several people and wants a say over agents' screens on Linux. Each is an environment variable or a key in the operator settings file, and only an administrator sets them.

- `CLAWBOO_COMPUTER_LINKS` (`computerLinks`): `view` turns control links off, so nobody takes over a screen through a link, and `off` turns every link off. It is checked on every request, so a link made earlier stops working too, and with `off` the access gate admits nothing on `/api/computer-link/*` without the access cookie. People who can sign in to the dashboard can still watch and take over there. The Links buttons say when an administrator turned them off.
- `CLAWBOO_XVNC_PATH` (`xvncPath`) and `CLAWBOO_CUA_DRIVER_PATH` (`cuaDriverPath`) name the `Xvnc` and the Cua Driver to use, such as a packaged or hardened build. A named program is the only one used, it is never downloaded, and it runs only when it, and every folder above it, can be changed by no one but root and the user running Clawboo, with no link anywhere in its path. A named `Xvnc` must also be TigerVNC's. One that fails a check is not run, nothing runs in its place, and the Screen view or Connect says why.
- `CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL` (`disableDesktopToolsInstall`) turns off downloading the desktop tools from the dashboard. Copies installed earlier keep working.
- `CLAWBOO_MAX_AGENT_DISPLAYS` (`maxAgentDisplays`, 1 to 64) caps how many agent displays run at once, apart from the cap on runs. Unset, it follows `CLAWBOO_MAX_AGENT_BROWSERS`, as before.

Also for agents' screens:

- Cua Driver's browser tools (which reach a browser through its debugging port, outside the agent browser's checks), its scripting tools (which run any of its tools in one call), its install and update tools and its settings tools are now refused outright. They are no longer offered to agents, no grant or approval turns them on, and the connectors API lists them as skipped, with the reason. A tool of a newer release is refused too when a part of its name marks it as one of these kinds.
- Clawboo installs a pinned release of the desktop tools only once it has been public for 14 days.
- A display keeps its cookie and sockets in the runtime folder of the user who runs it (`XDG_RUNTIME_DIR`, then `/run/user/<uid>`) when that folder is in memory and closed to everyone else, so they are not written to the data folder or a home folder and are gone after a reboot. Otherwise they stay where they were, under the data folder or in the agent user's home. The environment variables page says how to give an agent user one at boot, and why not by turning on lingering.
- The operator settings file takes two new kinds of value: an absolute path written plainly (no `.` or `..` part, no doubled or trailing slash) and a whole number in a range. Anything else stops the server at startup, as for every key.
