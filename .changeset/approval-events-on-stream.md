---
'clawboo': patch
---

The live event stream, `GET /api/obs/stream`, takes `?kinds=` to send only some event kinds. A client can now follow approval requests and answers with `?kinds=approval_requested,approval_resolved` instead of polling the approval queue, without receiving every other event or waiting behind them after a reconnect. The stream also takes `?afterSeq=<seq>`, the cursor name `GET /api/obs/events` uses; before, it ignored that and replayed the whole log. A malformed `Last-Event-ID` header now falls back to the cursor in the query instead of replaying from the start. The Observability API page shows how to start from the approval queue and then follow the stream.
