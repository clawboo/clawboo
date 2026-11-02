---
'clawboo': patch
---

Creating an OpenClaw agent works on OpenClaw 2026.9. That Gateway refuses TOOLS.md, and Clawboo wrote one for every new OpenClaw agent, so **Create Boo** and Marketplace deploys failed partway: the agent existed in the Gateway without its AGENTS.md or its command permissions. Clawboo no longer sends TOOLS.md. A Marketplace member's tool notes, such as its skill list, now go into its AGENTS.md under a **Tools** heading, the same move `openclaw doctor` makes on upgrade, and members on other runtimes no longer get a TOOLS.md nothing reads. **Agent Files** no longer offers an empty TOOLS tab; a TOOLS.md that already has text still shows.
