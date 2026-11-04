---
'clawboo': patch
---

Claude Code no longer reads as ready when only a `claude` CLI is installed. Every Claude Code run loads the Claude Agent SDK and starts the SDK's own `claude` binary, never a CLI on `PATH`, so an install with the CLI alone read **Connected** once a key was saved while each of its runs failed asking for the SDK. Claude Code now reads as installed exactly when the SDK and its binary sit next to Clawboo, and the health check agrees. **Install** fetches the SDK (`npm install -g @anthropic-ai/claude-agent-sdk@0.3`) instead of the CLI; on a one-off `npx` run or a source checkout, which cannot load a globally installed SDK, it says what to run instead.
