---
'clawboo': patch
---

`POST /api/obs/ingest` is removed. Nothing in Clawboo called it: the server writes every event in the observability log itself. The read routes under `/api/obs/` are unchanged.
