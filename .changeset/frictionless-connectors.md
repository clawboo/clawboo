---
'clawboo': minor
---

Make connectors something you turn on rather than something you configure.

The Connectors tab used to answer "what is this" and leave "how do I get it" to
you. Every card now carries a price and a verb: Ready, One click, Needs a key,
Needs a folder, and the button next to it does that thing without opening
anything. The shelf is ordered by how close each entry is to working, so the top
of it is what you can have right now. The `npx` command, the pinned version and
the paste-into-another-runtime block moved into a Technical details disclosure;
they are one click away rather than the first thing you read.

The `3/3 risk` chip is gone. It counted lethal-trifecta legs, which describe what
a connector can reach rather than whether it is safe, and a bare fraction beside
a name reads as a score. In its place the detail pane states the consequences in
sentences, and lists the actual tools your agents can call once it is running.

GitHub connects now. Its authorization server publishes no dynamic registration
endpoint, so clawboo could never sign itself in, and the tile said so and stopped
there. Its MCP server accepts a personal access token, which makes it one field.

The Ghost Graph's buttons say what they do. `Detach` is now `Stop sharing`,
because it revokes another agent's access and the old label read as "remove this
connector". There is a real `Turn off`. `Sign in` runs the sign-in instead of
showing a toast about it, and `Configure` opens that connector's card rather than
dropping you on a panel with no indication which row was yours.

Agents know what they could have. A user-facing turn now carries the connectors
that are live, a few that are one click away, and an instruction not to work
around a missing one: no browsing to a vendor's site to read what a connector
would return, and no asking you to sign in on its behalf.

And the directory got much longer without getting less honest. 229 servers from
the official MCP registry sit below their own divider, with their own count that
never merges into the curated one, loaded only when you ask for them. clawboo has
not read any of them and says so. Adding one shows you the exact command before
anything runs, and on confirm it becomes your own entry rather than something
clawboo vouched for.
