---
'clawboo': patch
---

Connectors and the shell commands you approve for a Clawboo Native agent keep npm's own prefix, cache and update-check settings. Their environment starts empty so that no credential leaks into them, and that also dropped every `npm_config_*` variable, so an approved `npm install -g` failed with `EACCES` on a server whose npm prefix points at a folder of its own. `npm_config_prefix`, `npm_config_cache` and `npm_config_update_notifier` now pass through in either spelling; no other npm setting does, so npm credentials such as `npm_config__authToken` stay out. Connectors also start with `npm_config_update_notifier=false` unless it is set, so an `npx` start does not check the registry for a newer npm.
