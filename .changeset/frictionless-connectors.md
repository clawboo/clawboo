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

Agents know what they could have, and can hand you the button. A user-facing turn
now carries the connectors that are live, a few that are one click away with what
each costs, and an instruction not to work around a missing one: no browsing to a
vendor's site to read what a connector would return, and no asking you to sign in
on its behalf. When an agent does need one, it names it and stops, and the answer
arrives in the conversation as a card whose buttons are priced the same way the
shelf prices them. Pressing one opens that connector's own page. Nothing connects
on an agent's say-so.

And the directory got much longer without getting less honest. 230 servers from
the official MCP registry sit below their own divider, with their own count that
never merges into the curated one, loaded only when you ask for them. clawboo has
not read any of them and says so. Adding one shows you the exact command before
anything runs, and on confirm it becomes your own entry rather than something
clawboo vouched for.

Every remaining seam between wanting and having got one click shorter. Saving
what a connector asked for also connects it, in one Save and connect button.
The folder and file fields carry suggestion chips computed server-side, so
every chip is a path that exists on this machine. A search that misses
everything says so, instead of showing a divider announcing an inventory of
zero. And the pinned-version contract on community entries is now enforced by
a real check rather than by spelling: a registry row carrying a dist-tag or a
range is refused at ingest and again in CI, because a consent step that shows
one command must never run another.

The long tail is now drawn from the whole registry. The ingest paged through a
name-sorted listing under a fixed page bound, which did not sample the registry
so much as truncate it alphabetically: it stopped partway through the letter C
and never reached the namespace where nearly every well-known open-source MCP
server publishes. It now walks all 24,000 entries, asks for latest versions
only, and picks the 400 by most-recently-maintained rather than by alphabetical
position. Entries that collide on a name keep their publisher instead of
silently dropping, because sixty-six servers are called some variant of "mcp".

And the snapshot's digest is checked. It was recorded and never verified, and
could not have been verified as written, because the recorded hash covered the
generator's raw output while the committed bytes are the formatted ones. It now
covers the file's canonical form, and `pnpm verify:connectors` recomputes it, so
a hand-edited entry fails CI instead of shipping.

Connectors is its own place now, in the sidebar under Marketplace. It was the
fourth tab of a shop you visit once, which is the wrong shelf for the recurring
errand of connecting the tools your agents actually use.

The list looks like one too. Every connector carries its real logo, extracted
from the public-domain Simple Icons set and committed rather than fetched, so
the shelf still renders with the network off and browsing it still leaks
nothing. A connector that is a capability rather than a brand gets a glyph for
what it does; the unchecked long tail gets a monogram tinted from its own name.
Cards became rows, the state pill became the button's verb, and a connected
connector is a green tick with no sentence attached.

The two lists are named for the reader: Popular and More connectors, each with
its own count. The counts still never merge into one total.
