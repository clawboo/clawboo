---
'clawboo': minor
---

Team memory is now a graph, and it learns which facts were worth keeping.

Memory used to be a flat list behind the settings gear. It is now a sidebar
view: facts cluster by what they have in common, similar facts link up, hubs
draw bigger, and a procedure and its versions collapse into one node. Type to
dim everything that does not match, press Enter to run a real search and light
up the hits with their neighbours, click a node to read it in full and walk
outward through its links.

Underneath, recall got an opinion. Agents can now say whether a fact they were
given actually helped, and those reports decay over thirty days, so a fresh
correction outweighs an old success. A fact two different teammates found
useful is preferred and gets surfaced first; one that misled someone is
dropped from automatic recall entirely, though it stays searchable with its
status visible. Recall also walks one hop out from its best matches, avoiding
hub facts so a single popular note cannot crowd out the rest, and every
recalled line now carries an id the agent can cite back.

Facts also record where they came from: which agent, which runtime, which task.
Provenance rides outside the signed scope, so it describes without granting,
and an unverified session records nothing rather than something it made up.

Nothing is required to get this. Without an embedding provider the graph builds
from tags alone and says so plainly rather than quietly showing less.
