---
'clawboo': patch
---

A provider key set in the environment Clawboo is started with, such as `ANTHROPIC_API_KEY`, now shows as connected on the Providers page, where it used to read as not connected even though runs used it. The row says the key comes from the environment and offers no Update or Disconnect, since the dashboard cannot change it; when a saved key exists too, it says the one in the environment is used first. Setting up OpenClaw still reuses only a saved key, so a key from the environment is never written to disk.
