---
'clawboo': patch
---

Refuse an unusable access token, write credential files owner-only, and keep review worktree teardown inside its folder.

**An access token with an unsupported character stops the server.** `STUDIO_ACCESS_TOKEN` may use only `[A-Za-z0-9._~-]`. A token with any other character, such as the `+`, `/` or `=` in `openssl rand -base64` output, used to turn the access gate off with a warning and keep running. On a loopback bind behind a reverse proxy on the same machine, that left every `/api/*` route open. The server now logs a `SECURITY: refusing to start` error naming the character and the allowed set, and exits 1, on every bind. `CLAWBOO_ALLOW_INSECURE=1` does not skip it: that variable allows running with no token, not with one the gate cannot use. If your server stops at boot after upgrading, regenerate the token with `openssl rand -hex 24`.

**Files that hold credentials are readable by you only.** OpenClaw's `~/.openclaw/.env`, each OpenClaw agent's `auth-profiles.json`, Clawboo's `~/.clawboo/settings.json` and the file `clawboo backup` writes are now mode `0600`. An existing file is narrowed to `0600` before new contents are written into it, and Clawboo refuses the write when it cannot narrow a file others can read, and `~/.openclaw` and `~/.clawboo` are created `0700` when Clawboo creates them. A backup file is `0600` from the first byte, and a backup that fails removes its partial file. Modes are best-effort on Windows.

**Review worktree teardown stays in its folder.** Removing a reviewer's checkout now refuses any path that is not directly inside the review worktree folder, instead of deleting whatever path it was given.
