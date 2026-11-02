---
'clawboo': patch
---

"Do not ask again for this for 30 days" works on connector calls that change something. The box saved a rule, but a second risk check asked again on every call without reading it, so the prompt came back every time. That check now honors the rule. Calls that delete or destroy something never offer the box and always ask. Answers remembered by an earlier version, when the box could not stop these prompts, are cleared once on the first start after the upgrade, so none of them starts allowing changes nobody agreed to remember.
