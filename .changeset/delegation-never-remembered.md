---
'clawboo': patch
---

Risky hand-offs are never remembered. An `allow_always` answer to a risky hand-off, which only the API could send, used to stop that leader's risky hand-offs from asking again, with no end date and nothing in the dashboard to undo it; for Boo Zero it covered every team. Now every risky hand-off opens its own approval, marked never-remember, and an `allow_always` answer allows that one hand-off. An `allow_always` recorded before this change no longer skips anything.
