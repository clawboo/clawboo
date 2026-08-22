---
'clawboo': minor
---

Add a connectors directory to the marketplace and surface capability health on the Ghost Graph.

The marketplace gains a Connectors tab listing 20 verified MCP connectors, each with a
copy-paste config block for Claude Code, Codex or VS Code. It is a directory rather than an
installer: clawboo does not yet run an outbound MCP client, so the tab helps you attach a
connector to a runtime you already use.

On the graph, capability tiles now explain themselves. A single status badge follows a strict
precedence, and the tooltip carries the diagnostics and the runtime's own remediation hint,
which the graph previously computed and discarded. Connector tiles gained a source handle so a
connector can be shared with a second agent, refused connections now say why, and tiles collapse
to dots when zoomed out.

Also fixes the MCP config transcoder, which claimed a comment preserving merge but silently
emptied the file it could not parse.
