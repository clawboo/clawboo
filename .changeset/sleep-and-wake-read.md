---
'clawboo': minor
---

A computer or service that stops Clawboo when nobody is using it can now ask it, in one read, whether to: `GET /api/system/idle` says whether a person is here, whether an agent run is going, and when the next routine, OpenClaw cron job or Hermes job is due, so it can start Clawboo again just before. A person counts while a dashboard tab is visible and focused and someone touched it in the last 15 minutes (the dashboard says so with `POST /api/system/presence`), and for a minute after they do something, such as answering an approval, sending a message or a comment, or starting or stopping work. Reads never count, and neither does an open tab's polling or a request a sign-in proxy merely vouched for.
