---
'clawboo': patch
---

Disconnecting a runtime no longer deletes keys other runtimes run on. It deletes only the saved keys that runtime alone reads, keeps the rest for the runtimes still using them, and stops the disconnected runtime from using any key until you connect it again. The dialog now names each saved key it deletes and each one it keeps. Claude Code and Hermes can connect again with a kept key through **Use saved key**.
