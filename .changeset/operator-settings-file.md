---
'clawboo': minor
---

Admins who deploy Clawboo for a team can pin settings in one file.

Put a JSON file at `~/.clawboo/operator.json`, or anywhere with `CLAWBOO_OPERATOR_SETTINGS` pointing at it. Every key also has an environment variable, which wins over the file. The first keys are `disableSelfUpdate` (`CLAWBOO_DISABLE_SELF_UPDATE`), `disableBrowserAutostart` (`CLAWBOO_DISABLE_BROWSER_AUTOSTART`) and `catalogIndexUrl` (`CLAWBOO_CATALOG_INDEX_URL`).

A pinned setting applies to everyone. The new **Deployment** card in **Settings** > **System** shows each setting, and a pinned one reads "Set by your administrator" with no way to change it there. `GET /api/system/operator-settings` returns the same, and `PUT /api/system/operator-settings/:key` saves a value for a setting nobody pinned, which applies to the whole install.

Clawboo reads the file once at startup and never writes it. A file it cannot trust stops the server with `CONFIG: refusing to start.` and the reason: invalid JSON, an unknown key, a value of the wrong type, a file any user can write, a `CLAWBOO_OPERATOR_SETTINGS` naming a missing file, or anything that looks like a credential. An invalid value in one of the keys' environment variables stops it the same way.
