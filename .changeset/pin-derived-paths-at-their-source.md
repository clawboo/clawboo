---
'clawboo': patch
---

Close out the remaining hardening on derived filesystem locations and the Windows shim launcher. A task's worktree directory is now pinned under the worktree root at the one place it is derived, so every consumer of that location, from provisioning through scaffold writes to the recursive cleanup, builds on a path that has already been checked, and the directory created for a fresh worktree is taken from that checked value rather than resolved a second time from raw inputs. A runtime's per-identity home gets the same treatment: the assembled path is confirmed to sit under the runtimes root before anything creates or hands out the directory that will hold a runtime's private state.

The Windows `.cmd`/`.bat` shim route now double-quotes the resolved command token on the cmd.exe line instead of caret-escaping it. Quotes are what cmd.exe honours in the program position, so a resolved path containing spaces, ampersands, or parentheses stays one literal token, and a quote can never appear inside a Windows file name to close the wrapping early. The CLI sign-in relay also spawns its two modes as two distinct calls, the cmd.exe shim route and the plain no-shell argv route, so each spawn is exactly the mode it claims rather than a merge of both possibilities.
