---
'clawboo': minor
---

Make the connector directory reachable, and give it its logos.

Four hundred registry servers shipped and almost none of them could be found.
The band holding them rendered only under the Unchecked pill or when a search
found nothing curated, so the default view looked like the whole of clawboo's
connector support at nineteen entries. Searching was the only other way in and
it failed on the words people actually type: one curated match on a tag was
enough to suppress the band entirely, so "search" hid sixty-seven registry
matches behind a single hit and "file" hid twenty. A search now shows both
populations, still under their own headings with their own counts.

The sixty that did render were the wrong sixty. The snapshot is written in
publisher order, so the visible page was every publisher sorting before
`io.github` and the three hundred and twenty-seven entries under it could not be
reached by scrolling at all. There is a Show more button now, and the band leads
with the entries whose names clawboo recognises, which is the only signal
available: the registry publishes no downloads, no stars, nothing.

Logos where there are logos. brandMarks.ts claimed to be generated and had no
generator, so its thirteen paths could not be reproduced or extended.
scripts/generate-brand-marks.ts now builds it from simple-icons and reproduces
all thirteen byte for byte, plus thirty-two registry entries that turned out to
name something people know: Docker, GitLab, Instagram, Bitbucket, Wikipedia,
QuickBooks, Zotero and the rest. Matching is conservative and every judgement
call is a named alias, because a wrong logo says a server is official when it is
one developer's project. Most registry servers have no logo at all, and those
still draw a monogram rather than a borrowed one.

Two rendering faults go with it. Brand marks were broken everywhere except the
connectors panel: the stylesheet holding their colours mounted only there, so
every mark on the graph canvas drew black on a transparent tile. And the
monogram's letterform was fixed at a lightness chosen for a white page, which
left it close to invisible in dark mode.

The thread picker asks what kind first. Pulling a thread onto empty canvas
opened one list of fifty-one rows with thirty-two skills above nineteen
connectors, so the first connector sat past a full screen of scrolling. It now
opens on three rows, Connectors, Skills and New agent, each carrying its own
count. Typing skips the chooser and searches every kind at once, so anyone who
knows the name pays nothing for the extra step, and the last row creates an
agent named after the query. That also removes the second text field, which used
to sit inside the list and fight the search box for keystrokes.

Composio ships as a curated connector, which closes the hole where clawboo's
own connectors stop. clawboo cannot register an OAuth app with Google or
Atlassian or Salesforce, so there is no Gmail, Slack, Drive or Jira entry and
there cannot be one. Composio brokers all of them.

It needs no integration code and no pasted key. Its endpoint advertises its
authorization server at the standard well-known path, that server offers dynamic
client registration with PKCE and a public client, and clawboo's existing OAuth
path handles the rest. It connects the same way Linear and Sentry already do,
and there is no Composio-specific code anywhere in the repo.

The connector says what it costs you, in its own detail view rather than in a
document nobody opens: Composio signs you in to each app and keeps that app's
tokens on its own servers, clawboo holds only a token for Composio itself, and
anything connected through it is reachable by Composio.
