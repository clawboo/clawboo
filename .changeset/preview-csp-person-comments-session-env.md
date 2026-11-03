---
'clawboo': patch
---

Keep scripts off in previews opened in a tab, accept a comment as yours only from the dashboard, and keep a parent Claude Code session out of agent runs.

**A preview runs no script, even in its own tab.** The task drawer's **Preview** frame already ran no scripts, but **Open** loaded the same agent-built page in a tab of its own, from the dashboard's address, where its scripts ran and could call the API as you. Every preview response now carries `Content-Security-Policy: sandbox allow-same-origin`, the frame's own flags, so the page is just as inert in a tab. Styles and images still load.

**Only the dashboard comments as you.** A comment posted as yours (`authorType: 'user'`) steers the agent doing the task, and any local program could post one with `curl`. `POST /api/board/:taskId/comments` now keeps `user` only for requests from the dashboard's own page, judged by the browser's `Sec-Fetch-Site` and `Sec-Fetch-Mode` headers. A `user` comment from anywhere else is saved as an agent comment and reaches no agent. This is a speed bump, not a security boundary: a program running as you can send the same headers or write the database.

**Agent runs no longer inherit a Claude Code session.** A Clawboo server started from a terminal inside Claude Code passed that session's `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` on to every runtime it started. They are now removed with the other scrubbed variables. Claude Code settings such as `CLAUDE_CODE_USE_BEDROCK` still pass through.
