---
'clawboo': patch
---

Connector access set to ask every time (`approvalPolicy: always`) now always asks. A standing rule from an earlier **Always** answer used to be checked before the policy, so a remembered tool ran without asking even under `always`. The policy now comes first: a standing deny still denies, a standing allow no longer skips the prompt, and the request is marked never-remember, so the card offers no **Always** and an API `allow_always` saves no rule.
