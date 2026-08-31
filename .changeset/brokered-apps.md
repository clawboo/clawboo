---
'clawboo': minor
---

Gmail, Slack, Jira and thirty-eight more, through Composio.

Apps clawboo cannot sign in to on its own now sit in their own band on the
connectors page. Paste a Composio project key once, press Connect on an app,
approve it at the provider, and it stays connected. Every connected app also
appears as its own node on the graph, attached to the agents that can reach it.
That last part is deliberate: a single node marked Composio would hide the fact
that an agent can read your email, where a Gmail node says it plainly, and a
thing you can see is a thing you can take away.

This replaces a first attempt that did not work, and the reason it did not is
worth writing down.

That version attached to Composio's MCP endpoint, which is the surface meant for
MCP clients like Claude Desktop, and then tried to run product features by
calling the model-facing meta-tools and reading their free-text answers. Every
piece of machinery it grew existed to recover typed facts from prose: a JSON
Schema sniffer that guessed argument shapes at runtime, a parser for status
words, a retry ladder for a default action whose own description says it "always
creates a new auth link", and finally a third loading state to cover a three
second read on page load. Pressing Connect on an already-connected app minted a
fresh consent link and sent the operator back to the provider, every time.

Composio's documentation points applications at their API instead, and their own
reference application does the whole integration in a few hundred lines, because
a typed answer needs no recovery. This now does the same: one typed client, one
call that says which apps are connected, one call that starts an authorization.

Eight hundred and eighty lines went, and two hundred and forty came back. Gone
with them: forty-one apps declared as catalog connectors that could never be
launched and never held a session, the `brokeredBy` escape hatch and the eleven
branch sites that existed to tell everything downstream that this kind of
connector was not really one, and the schema inference layer entirely. The
catalog is twenty honest connectors again.

The key is written to the encrypted vault and never returned. Every response
about it carries a boolean and nothing else.
