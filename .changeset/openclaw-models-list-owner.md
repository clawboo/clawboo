---
'clawboo': patch
---

The OpenClaw model pickers show OpenClaw's live model catalog again on OpenClaw 2026.9. That version refuses to list models when several agents are configured and none is named the owner, which is typical of an install running a Clawboo team, so the pickers had quietly fallen back to Clawboo's built-in list and model context windows were unknown. Clawboo now asks again for your default agent (the one marked default, else `main`, else the first) when OpenClaw refuses, and leaves installs that list fine unchanged.
