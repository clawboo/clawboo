---
title: 'Add a connector'
sidebarTitle: 'Add a connector'
description: 'Add or change an entry in @clawboo/connector-catalog, the offline connector directory, and pass the checks CI runs on it.'
keywords:
  [
    '@clawboo/connector-catalog',
    'connector-catalog',
    'connectors',
    'MCP server',
    'connector directory',
    'verify:connectors',
    'ingest:connectors',
    'generate:brand-marks',
    'community connectors',
    'brokered apps',
  ]
---

`@clawboo/connector-catalog` is the directory the Connectors view shows: the curated connectors Clawboo has checked
itself, a committed snapshot of the official MCP registry (the community entries), and the apps reachable through
a broker. It is plain data plus lookups, with no runtime dependencies and no network access, so the directory
renders with no loading state even offline.

Use this page when you add or change a curated connector, refresh the community snapshot, or add a brokered app.
How people connect one and give it to an agent is on [Connect tools to your agents](/using/connectors).

## What lives where

| Path (`packages/connector-catalog/`)               | Holds                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                     | `ConnectorDefinition`, the shape of one entry                                                                     |
| `src/sources/dev.ts`, `data.ts`, `productivity.ts` | the curated entries, grouped by area                                                                              |
| `src/catalog.ts`                                   | the merged list and its lookups: `connectorBySlug`, `connectorsByCategory`, `searchConnectors`, `connectorCounts` |
| `src/connectable.ts`                               | `connectRefusal` and `isConnectable`, the one rule the server enforces and the browser renders                    |
| `src/snippet.ts`                                   | `connectorSnippet`, a paste-ready config block for Claude Code, Codex or VS Code                                  |
| `src/generated/community.ts`                       | the community snapshot, generated and loaded only through the `./community` entry point                           |
| `src/brokeredApps.ts`                              | `BROKERED_APPS`, the apps a broker can reach; display rows, not connectors                                        |

An entry is a definition, not an install. Connecting one creates a `connectors` row in the database, its tools
show up in the capability inventory, and no agent can call them until someone grants the connector to that agent
(see [@clawboo/governance](/reference/packages/governance)).

## Add a curated connector

<Steps>

<Step title="Write the entry">

Add a `ConnectorDefinition` to the source file for its area, with `provenance: 'curated'` and a kebab-case `slug`
(the catalog's key, also used for its logo and its snippets). Give it a `displayName`, write `description` in plain
verbs ("Read and write issues"), pick a `category`, add search `tags`, and set `popular: true` only for a name
people arrive looking for.

</Step>

<Step title="Pin the launch">

The `launch` field says how to start the server. For a local server, set `transport: 'stdio'`, the `command`, and
`args` with an exact version baked in (for example `npx -y <package>@<version>`), and put the same version in
`pinnedVersion`. A bare package name resolves to the latest release on every spawn, so unpinned entries fail the
checks. For a remote server, set `transport: 'streamable-http'` and an `https` `url`.

</Step>

<Step title="Describe the credentials">

Pick `auth.kind`: `none`, `api-key`, `bearer` or `oauth`. In `auth.inputs` (empty for `none`, at least one for
`api-key`), list one input per credential with its `key` (the variable or header name), a `label` in the vendor's words, a one-line
`description`, a `docsUrl` where a person makes it, `required`, and `secret: true` for anything secret, so it lives
only in the vault. Never put a value in the entry.
For OAuth, pin the `scopes` and explain them in `scopesRationale`. Set `needsPreregisteredApp` when the provider
offers no dynamic client registration, because Clawboo cannot sign itself in there.

</Step>

<Step title="State what it can reach">

`egressAllow` lists the hosts it talks to. `trifecta` says, at its most permissive, whether it reads private data,
ingests untrusted content and can send data out; the grant rules use the union of these across a run. If the server
will not start without a path or value only a person can supply, set `requiresUserArgument` and describe it in
`userArgument` (with `replacesArg` when the args hold a placeholder to replace). A browser connector also declares
`perAgentProfileFlag` in its `launch`, so each agent gets its own browser profile.

</Step>

<Step title="Run the checks">

Try the server against its real package or endpoint before you commit; every curated entry was checked that way.
Then run:

```bash
pnpm --filter @clawboo/connector-catalog test
pnpm verify:connectors
```

The package tests validate the shape and the honesty rules (pinned versions, `https` endpoints, no secret values,
secret inputs marked, declared egress, browser profiles). `pnpm verify:connectors` is the offline gate CI runs, and
`pnpm verify:connectors --live` also re-resolves every pinned version and dials every remote endpoint; it needs the
network, so run it by hand.

</Step>

<Step title="Add the logo">

Run `pnpm generate:brand-marks`. It rebuilds `apps/web/src/features/connectors/brandMarks.ts` from simple-icons and
attaches a mark only when the connector's display name, the first word of it, or its slug (lower-cased, punctuation removed) matches a simple-icons title or slug, or through an entry you add to
`ALIASES` in `scripts/generate-brand-marks.ts`. A connector with no match shows no logo, which is better than the
wrong one.

</Step>

<Step title="Check it in the dashboard">

Start the dev server and open **Connectors**. You should see the new entry in the curated list, with the button
that `COST_COPY` in `src/cost.ts` gives its state: **Turn on**, **Connect**, **Add key** or **Choose folder**.

</Step>

</Steps>

## Refresh the community snapshot

`pnpm ingest:connectors` snapshots the official MCP registry into `src/generated/community.ts` and updates the
count file beside it. Treat the result as a reviewed change: it is a diff a person reads, and it never runs on the
release path, so the community list cannot change under users without a release. `pnpm verify:connectors` checks
the committed snapshot against its recorded digest.

Three rules keep the community entries honest:

- **They cannot be connected with one click.** `connectRefusal` returns `community-unsandboxed` for them: a
  community server would run as you, unsandboxed, and nobody at Clawboo has read it. A person who trusts one can add
  the same server as a custom connector.
- **They load late.** The SPA imports `@clawboo/connector-catalog/community` only when someone scrolls to them or a
  curated search finds nothing, so the snapshot stays out of the first page load.
- **Counts stay split.** `connectorCounts()` returns curated and community numbers separately, and the UI never
  shows one combined total.

## Add a brokered app

`BROKERED_APPS` lists the apps a broker (Composio) can reach. Each row has Clawboo's `slug` (also its logo key), a
`name`, a `category`, a `description`, and the broker's own `toolkit` name. Copy the toolkit name from the broker's
toolkit page: it often differs from the slug (`googlecalendar` against `google-calendar`). These rows are never
launched or connected one by one, and whether an app is connected comes from the broker.

## Who reads the catalog

- **The server**, in the connector routes and `apps/web/server/lib/connectors/`, which launch connectors through the
  [@clawboo/mcp](/reference/packages/mcp) connector client with `resolveLaunchArgs` and an allowlisted environment.
- **The SPA**, in the Connectors view and the connector request card an agent's reply can carry (`ask.ts`).
- **Root scripts**: `scripts/verify-connectors.ts`, `scripts/ingest-connector-registry.ts` and
  `scripts/generate-brand-marks.ts`, which import the package source by relative path.

Because `connectRefusal` is shared, the server refuses exactly what the browser greys out, so change it in one place
and both follow.

## Related

- [Connect tools to your agents](/using/connectors): connecting a connector and giving it to agents.
- [@clawboo/governance](/reference/packages/governance): the grant rules that decide each connector tool call.
- [@clawboo/mcp](/reference/packages/mcp): the client that launches and talks to connectors, and its OAuth flow.
- [Connectors API](/reference/rest-api/connectors): the routes behind the Connectors view.
