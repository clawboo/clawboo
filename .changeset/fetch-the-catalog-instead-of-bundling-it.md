---
'clawboo': minor
---

The agent and team catalog is no longer bundled into the published CLI. Browsing it now costs a thin index rather than the whole corpus. The grid reads a name, a summary, and the tags, and the two large fields it never displayed, the full instruction body and the skill text, accounted for most of what every install was carrying. Those load per entry, when you open one. A small compiled seed still ships so a fresh install has something to show before it has reached the network, and the rest is served from `catalog/`, which is excluded from the npm tarball. Each pack's bytes are checked against a recorded hash before anything parses them, so a truncated or altered file fails closed rather than being read.

The catalog itself grew to nineteen packs, seventeen of them adapted from upstream community repositories under permissive licences, each pinned to the commit it was taken from. Every card and detail view now names where its content came from, giving the repository, the commit, and the licence, because this is community work rather than Clawboo's own. Clawboo does not review what these agents and skills instruct a model to do, and the marketplace says so at the point where you are choosing rather than only in the documentation. The final call on whether to run something is yours.
