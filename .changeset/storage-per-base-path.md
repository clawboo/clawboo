---
'clawboo': patch
---

Two Clawboo instances served under different path prefixes on one hostname (`CLAWBOO_BASE_PATH` behind a reverse proxy) no longer share the dashboard's browser storage. Browser storage belongs to the hostname, not the path, so a new instance skipped its welcome screen because another one had finished it, and the theme, layout, board view, tour and update-check state carried over between them. Every key the dashboard stores now starts with the instance's prefix (`/a:clawboo.theme`), including the theme read before the page paints. A key saved by an earlier release, without the prefix, moves to the first instance that reads it, so an upgraded instance keeps its settings. An instance served at the root keeps its keys exactly as they are.
