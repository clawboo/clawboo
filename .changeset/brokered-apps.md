---
'clawboo': minor
---

Gmail, Slack, Jira and thirty-eight more, as ordinary rows.

clawboo cannot register an OAuth application with Google or Atlassian or
Salesforce, so the connectors it could offer stopped exactly where brokered
sign-in begins. That was not an oversight, it was a boundary, and it is why a
connector directory with twenty entries had none of the apps most people use.

Forty-one of them now sit in the shelf beside clawboo's own connectors, sorted
by how likely you are to recognise the name rather than grouped under whoever
brokers them. Press Connect on Gmail and it connects. The broker comes along on
the first one and every app after that reuses the same connection, so there is
one session rather than forty-one, and one token rather than forty-one.

Nothing appears twice. GitHub, Linear, Notion, Sentry, Stripe, Figma, Airtable,
Supabase, Cloudflare and SQLite are all brokered too, and all of them are absent
from the brokered list: clawboo's own connector wins, and the catalog verifier
fails the build if a slug collides.

No API key anywhere. The whole flow runs over the broker's own MCP session,
which clawboo already opens through the ordinary OAuth path that Linear and
Sentry use. An earlier draft of this reached for a project key and a REST
client, and that would have created a second, separately scoped way into the
same service: two doors, two sets of connections, and no way to tell which one
an app went through.

The call is built from the broker's own published schema rather than from a
memorised argument shape, and it refuses rather than improvising. A tool that
takes fields clawboo has no value for, or an action enum with nothing in it that
starts a connection, produces a sentence naming what was missing. Sending the
call anyway is how an operator ends up connected to something they did not pick.

Thirty-two of the forty-one carry their real logo. The nine that do not, Slack
and Salesforce among them, have no mark in the public-domain icon set, so they
draw the same monogram every unbranded entry does.
