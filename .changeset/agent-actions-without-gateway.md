---
'clawboo': patch
---

Creating and deleting agents now works without an OpenClaw Gateway, and a new agent made on the Org chart always joins a team.

**Create.** Create Boo shows on every install. A new Boo runs on OpenClaw while a Gateway is reachable and on Clawboo Native when none is, and the dialog says which. It still joins the team selected in the sidebar. The graph's New agent, from a thread or the + button, follows the same rule; without a Gateway it used to fail with `gateway_disconnected`, and a new native agent now appears on the canvas at once instead of after a reload.

**Delete.** The trash icon in the all-agents list and a team's Delete with agents no longer need a Gateway. Delete with agents removes the team's agents instead of leaving them behind, and its confirm mentions the Gateway only when the team has an OpenClaw agent.

**Org chart.** A thread pulled off Boo Zero and let go on empty canvas gives the new agent the team selected in the sidebar, or the first team when none is, and the picker's New agent row names it. The agent used to be made with no team, and the Org chart did not draw it.

**Select in sidebar** is gone from the graph's right-click menu. It never marked anything in the sidebar; Open agent does.
