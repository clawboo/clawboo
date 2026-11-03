---
'clawboo': patch
---

A chat that loses its live connection no longer skips messages.

The team chat and 1:1 chat streams start at the newest message and only stored messages carried a resume id. A browser asks to resume only once it has received an id, so a connection that dropped before its first message reconnected at the newest message at that moment, and any message stored in between did not appear until the chat was loaded again. Both streams now open with a `cursor` event that carries the id they start from, so a reconnect resumes from there. Clients that do not listen for `cursor` see no change.
