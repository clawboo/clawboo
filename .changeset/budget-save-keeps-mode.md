---
'clawboo': patch
---

Saving a budget again no longer turns a hard cap into warn only. The Governance form started on **warn only**, so pressing **Set budget** for an agent, team or task that already had a hard cap silently switched it to a warning, and `POST /api/governance/budgets` did the same whenever a request left out `mode`. A save without a mode now keeps the budget's mode (a new budget still starts as warn only), and picking something that already has a budget switches the form to that budget's mode and says so under the form.
