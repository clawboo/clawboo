---
'clawboo': patch
---

A task that passed with debt opens in the task drawer again. Opening one used to replace the view with a "Couldn't load" error card, because the drawer could not show the open issues the check left. The Verification section now lists each open issue with its severity, what it is, and why it stayed open, for example `[security] Token logged in plain text: unresolved at cycle exhaustion`.

The Verification section's warnings are easier to read. "Written by the agent", "Review did not complete" and "Review returned nothing" were small amber text below the WCAG AA contrast floor. They now use the regular text color with an amber warning mark beside them.
