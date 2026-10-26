---
'clawboo': patch
---

Approving this device during OpenClaw setup no longer leaves the setup stuck. When the reconnect after approval failed, or OpenClaw still reported the device as unapproved, the approval card stayed on "Approved. Reconnecting…" with only Cancel to press. The setup now shows what went wrong with a Retry button, and Retry brings back a fresh approval card if the device still needs approving.

In onboarding, pressing Escape on the team step to go back to Add runtimes no longer disconnects an OpenClaw Gateway you just set up there.
