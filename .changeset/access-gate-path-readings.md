---
'clawboo': patch
---

Make the access token and the same-origin guard read a request's path the way the router does. Both now decide whether a request is an `/api/` request from every way the server reads its path, so every request the server routes to an `/api/` route needs the access cookie and passes the Origin and Host check, however its path is written. The MCP servers' attach-token exception applies only to a path that is under `/api/mcp/` every way it is read. A request whose target is a full URL instead of a path now gets `400` (`404` when Clawboo is served under a path prefix): browsers, reverse proxies and Clawboo's own clients always send a path.
