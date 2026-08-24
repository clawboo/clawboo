---
title: Connect an MCP server
description: Run a verified MCP connector from Clawboo itself, sign in to a remote provider, add a server of your own, and see how grants govern what its tools may do.
---

Use this page when you want an agent to reach something outside Clawboo: a Postgres database, a Linear workspace, a browser, your own filesystem. The **Connectors** tab in the [Marketplace](/using/marketplace) lists 19 verified MCP servers, all of which Clawboo can connect for you, plus 229 more from the MCP registry that it has not checked.

This is the one Marketplace tab that is not purely a catalog. Deploying an agent creates a record; connecting a connector starts a real process on your machine, or opens an authenticated session to somebody else's server, and hands its tools to your agents through the broker.

## Prerequisites

- Node on your `PATH`. A local connector is spawned with `npx`, and the first run downloads the pinned package.
- For a remote connector, a browser on the same machine as the server. Sign-in redirects to a loopback port.
- Nothing else. The catalog is committed, so the tab browses offline.

## The two kinds

| Kind       | What connecting does                                                             | What disconnecting does                                        |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Local**  | Spawns the server as a child process under your user account and lists its tools | Stops the process and reaps its tree                           |
| **Remote** | Opens an authenticated HTTPS session using the token you signed in with          | Closes the connection; your sign-in is kept until you sign out |

The tile tells you which one you are looking at, and the detail pane's copy changes with it.

## What each card costs you

Every card carries one word for how far it is from working, and a button that does that thing. Nothing needs the detail pane to get started, and the shelf is ordered by distance, so the top of it is what you can have right now.

| The card says      | The button    | What happens                                                              |
| ------------------ | ------------- | ------------------------------------------------------------------------- |
| **On**             | Turn off      | It is running. Its tools are in your agents' tool list                    |
| **Ready**          | Turn on       | Nothing to set up. Five of the nineteen are like this                     |
| **One click**      | Connect       | A tab opens at the provider's own consent screen, then it connects        |
| **Needs a key**    | Add key       | One field. The value goes to the encrypted vault, never to a settings row |
| **Needs a folder** | Choose folder | Name the directory the server may work in                                 |
| **Not reviewed**   | Add it        | A registry entry. You are shown the exact command before anything runs    |

The same predicate decides the card and the API, so a button you can see is a button the server will accept.

<Note>
The card never scores a connector. It used to show a `3/3 risk` chip counting [lethal trifecta](/appendices/glossary) legs, which describe what a connector can **reach** rather than whether it is safe. The detail pane says the same three things in sentences, where a consequence fits and a fraction does not.
</Note>

## Signing in to a remote connector

Clawboo has no registered OAuth app and cannot keep a client secret, so it registers **itself** with the provider, once per install, using [dynamic client registration](https://www.rfc-editor.org/rfc/rfc7591). The redirect lands on an ephemeral loopback listener rather than on an API route, because the redirect back is a cross-site navigation and Clawboo's always-on origin guard refuses exactly that.

A provider that publishes no registration endpoint cannot be signed into this way, and **GitHub** is the live case. Its MCP server accepts a personal access token instead, so its card reads **Needs a key**: create a fine-grained token scoped to the repositories your agents should work in, give it read and write on Contents, Issues and Pull requests, and paste it in.

Tokens and the client registration live in the same encrypted vault as connector credentials, namespaced per connector, and are never returned by any API. **Sign out** deletes both and stops the connection.

<Note>
Discovery is pinned to the server that answered: its OAuth metadata must live on its own origin, and the resource identifier it declares must name the server Clawboo is talking to. Without those two checks a compromised server could name somebody else's authorization server, send you to a genuine consent screen for that provider, and receive a token minted for them. See [SECURITY.md](https://github.com/clawboo/clawboo/blob/main/SECURITY.md).
</Note>

## Adding a server the catalog does not list

**Add your own MCP server** takes a command or a URL. A custom connector is connectable, and it gets no less access than a curated one: Clawboo assumes it reads private data, ingests untrusted content and can reach the network, because it cannot know otherwise. Adding one is the same act of trust as writing that command into any other MCP client's config.

## The long tail

Below the curated nineteen, behind its own divider, sit 229 servers from the official [MCP registry](https://registry.modelcontextprotocol.io). Press **Unchecked**, or search for something the curated set does not have, and they appear. The two counts never merge into one total, because Clawboo has read nineteen of these and none of the rest.

They are a committed snapshot, not a live fetch, so the directory still works with no network and does not change under you between releases. Refreshing it is a deliberate act: someone runs the ingest, reads the diff, and ships it.

**Add it** opens a confirmation, not a connection. It shows the exact command, the package and version it came from, and what it will ask you for:

> Clawboo has not checked this one. It will run on your machine, as you, with the same access to your files and network that you have.
>
> `npx -y pretrip-mcp@1.0.1`

Confirming turns it into one of **your own** entries, with its origin recorded, and it lands on the ordinary key flow from there. Clawboo vouches for nothing, you see the command before it runs, and finding it and running it are two clicks apart rather than a retyped command line.

## What happens to its tools

Discovered tools are namespaced `mcp__<slug>__<tool>` and registered with the broker, so both HTTP-attached agents and native in-process runs see them. A tool that cannot be represented, or whose name collides with one already claimed, is dropped and reported rather than taking the connector down with it.

Every connector-supplied tool is **grant-governed** from the moment you connect. Core builtins are not: they are Clawboo's own verbs, and a grant that could revoke them would be a switch for turning the product off.

## Governance

Connecting mints an **owner** grant, which records that Clawboo attached this connector. It is real and it gates real calls, but it is never drawn as an edge: the tile itself is that statement. Dragging a connector tile onto a second agent on the [Ghost Graph](/using/ghost-graph) creates an **operator** grant, which is the one that draws an edge and carries a **Stop sharing** control. A connector tile also carries **Turn off**, which stops the connector itself. The two are deliberately never in the same position, because they do different things to different people.

The badge on a tile is not a second reading of a status column. The graph and the broker call the same `decideGrant`, over the same rows, so an expired grant renders as expired because that is what the runtime would do with it. A connector whose tool list no longer hashes to what you approved shows **drift**, and that is deliberately not collapsed into an error: the remediation is to read what changed, not to retry.

## Environment and isolation

A connector child inherits an explicit **allowlist** of environment variables plus whatever credentials you entered for that connector. It never sees your provider API keys, your cloud credentials, or Clawboo's own vault key. Arguments are passed as an argv array, never as a shell string.

<Warning>
A connector child is still a process running as you. It can read your home directory, your SSH keys, and the Clawboo database. The environment allowlist is the vector a local-first tool can close; this one it cannot. Connect servers you would be willing to run yourself.
</Warning>

## Troubleshooting

**The first connect takes a minute.** A cold `npx` downloads the pinned package before the handshake completes. The card shows **Working** throughout, and a disconnect issued during that window waits for the attempt rather than reporting that nothing was connected.

**"Could not list tools".** The server came up and then failed discovery. Its own last words are included in the error where it printed any. The child is stopped, so nothing is left running.

**Sign-in opens a blank tab.** Your browser blocked the popup. Allow pop-ups for Clawboo and press **Sign in** again.

**Every call is denied with spec drift.** The connector no longer matches what was approved for it. Reconnecting re-pins the command and the launch argument you can see, but never the tool inventory, which nobody has reviewed. Clearing tool drift takes revoking the grant and granting it again.

## See also

- [Marketplace](/using/marketplace) for the other three tabs
- [Ghost Graph](/using/ghost-graph) for sharing and revoking a connector
- [Capabilities dashboard](/using/capabilities-dashboard) for the inventory view
- [Approvals](/using/approvals) for what happens when a call needs one
- [Ghost Graph](/using/ghost-graph) for `Turn off` and `Stop sharing` on a connector tile
