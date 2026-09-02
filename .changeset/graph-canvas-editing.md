---
'clawboo': minor
---

Build the graph on the graph.

The canvas could already author three kinds of edge: dropping a skill tile on a
Boo installed it, dropping a connector tile shared it, and dragging Boo to Boo
wrote a routing line. Every one of those gestures started from an 8-pixel
transparent handle inside a ring that only opened on an unlabelled click, so the
whole thing was unreachable. Releasing a thread on empty canvas hit a branch
that returned with the comment "the gesture just ends".

Every Boo now carries one visible port. Pull a thread and let go: on a node it
connects, on empty canvas a searchable picker opens where you dropped, listing
only what that thread can legally end in. Picking a row creates the thing there,
already wired. Typing a name creates a Boo in the same team as the one you
pulled from, already routed to it. Each Boo shows what it carries under its
name, so the ring stops being a secret.

Removing works the same way for everything. Click an edge and press Remove
Connection in its panel, or select it and press Backspace: routes, skills and
shares all come off, and a share carries an eight-second Undo. That Backspace is edge-only and
sits beside React Flow's own key handling rather than enabling it, because the
built-in path removes an agent from the screen without telling the server. Edges
that cannot be removed say why rather than offering a delete that silently does
nothing.

Spawning no longer rearranges the canvas. A node with no saved position looked
identical to a stale layout blob, so every spawn discarded every hand-placed
position and re-solved from scratch: the node you dropped jumped, and so did
everything else. A spawned node now records where it was dropped before it
arrives.

Configure on a connector tile is gone rather than relinked; it was the only
button on that toolbar that navigated away. Edit personality and Edit files
collapse into Open agent, because all three were the same call under three
labels. Credentials, folder pickers, custom servers and team creation are absent
from the canvas by design: each needs more than a name or a pick.

Three older defects go with it. The canvas lock froze dragging and selection but
left edge drawing live, so routing could be rewritten on a locked canvas. Two
handlers returned early when there was no OpenClaw Gateway, which is every
native install, silently swallowing connect and delete. And the agent detail
view's smaller graph carried its own narrower copy of the connection rules, so a
gesture that worked on one canvas snapped back on the other with nothing said.
That graph now shares the rule and scopes it: it draws one agent, so routing and
sharing say there is no second endpoint instead of validating and doing
nothing.
