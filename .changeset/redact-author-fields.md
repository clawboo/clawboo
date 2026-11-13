---
'clawboo': patch
---

Task comment and team chat events now keep their author fields (`authorType` and `authorAgentId`) readable in the event log API and in tool call records, instead of storing them as `[REDACTED]`. The secret masking treated any field whose name contains "auth" as a credential, so these fields were blanked along with real keys. Fields that hold credentials, such as `authorization`, `auth` and access tokens, are still masked. Events saved before this update keep the masked value.
