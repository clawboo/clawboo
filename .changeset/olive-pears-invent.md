---
'clawboo': minor
---

Add a connectors directory to the marketplace and surface capability health on the Ghost Graph.

The marketplace gains a Connectors tab listing 19 verified MCP connectors. clawboo now runs an
outbound MCP client, so 18 of them connect from the tab itself: it starts a local server as a
child process, or signs in to a remote one over OAuth and holds the connection. The tile says
which of the two it is, and what the connector still needs from you first, whether that is an API
key, a folder to work in, or a sign-in. GitHub is the one entry it cannot run, because that
provider requires a pre-registered OAuth app; its tile says so. Every entry still carries a
copy-paste config block for Claude Code, Codex or VS Code, which is the fallback for a runtime
you would rather attach it to yourself.

You can also add a server the catalog does not list, by giving clawboo the command or the URL.
Credentials and OAuth tokens go into the encrypted vault, namespaced per connector, and are never
returned by any API. A connector child inherits an explicit allowlist of environment variables
rather than clawboo's own environment. Signing out deletes the tokens and stops the connection.

On the graph, capability tiles now explain themselves. A single status badge follows a strict
precedence, and the tooltip carries the diagnostics and the runtime's own remediation hint,
which the graph previously computed and discarded. Connector tiles gained a source handle so a
connector can be shared with a second agent, refused connections now say why, and tiles collapse
to dots when zoomed out.

Also fixes the MCP config transcoder, which claimed a comment-preserving merge but silently
emptied the file it could not parse.
