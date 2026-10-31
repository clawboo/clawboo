---
title: 'Connectors API'
sidebarTitle: 'Connectors'
description: 'REST reference for connectors (MCP servers Clawboo runs or signs in to), the Composio broker, custom connectors, and the grants that govern them.'
keywords: ['misc', 'connectors', 'mcp', 'composio', 'custom connectors', 'grants', 'oauth']
---

A connector is an MCP server that Clawboo runs on this machine (a local process) or reaches over HTTP (a remote server). You supply its credentials: an API key, an OAuth sign-in, or a launch argument such as the folder a filesystem server may see. Connectors come from Clawboo's built-in catalog or from custom entries you add, and grants decide which agents may use their tools. Use this page when you script connector setup or audit who can use what.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. Every route is on the general rate limit; the routes marked **sensitive** also count against the stricter sensitive limit (see the [REST API overview](/reference/rest-api/index)). Errors use `{ "error": "<message>" }`; a `400` for a body that fails validation adds `details`, the validator's form and field errors.

Local connectors run as child processes of the Clawboo server, as your user, with no sandbox. The server does not tell callers apart: any request that passes the access gate can connect a connector or create a grant. See [Security](/operating/security) before you open Clawboo to other machines.

## Routes

| Method | Path                                            | Summary                                                     | Limit     |
| ------ | ----------------------------------------------- | ----------------------------------------------------------- | --------- |
| GET    | `/api/connectors`                               | List the connectors running now                             | general   |
| GET    | `/api/connectors/configured`                    | Which connectors have everything they need                  | general   |
| GET    | `/api/connectors/path-suggestions`              | Real folders or files to offer for a path argument          | general   |
| POST   | `/api/connectors/connect`                       | Start a connector and list its tools                        | sensitive |
| POST   | `/api/connectors/:slug/disconnect`              | Stop a connector and keep it stopped                        | sensitive |
| POST   | `/api/connectors/:slug/authorize`               | Start an OAuth sign-in for a remote connector               | sensitive |
| POST   | `/api/connectors/:slug/authorize/await`         | Wait for that sign-in to finish                             | general   |
| DELETE | `/api/connectors/:slug/authorize`               | Sign a connector out and forget its tokens                  | sensitive |
| GET    | `/api/connectors/:slug/config`                  | What a connector needs, and what is stored                  | general   |
| PUT    | `/api/connectors/:slug/config`                  | Store credentials and the launch argument                   | sensitive |
| GET    | `/api/connectors/composio`                      | Whether a Composio key is stored, and which apps are linked | general   |
| PUT    | `/api/connectors/composio/key`                  | Store a Composio API key                                    | sensitive |
| DELETE | `/api/connectors/composio/key`                  | Forget the Composio key                                     | sensitive |
| POST   | `/api/connectors/composio/apps/:slug/authorize` | Start linking one app through Composio                      | sensitive |
| GET    | `/api/connectors/custom`                        | List your custom connectors                                 | general   |
| POST   | `/api/connectors/custom`                        | Add or replace a custom connector                           | sensitive |
| DELETE | `/api/connectors/custom/:slug`                  | Remove a custom connector                                   | sensitive |
| GET    | `/api/grants`                                   | List grants                                                 | general   |
| POST   | `/api/grants`                                   | Create or update a grant                                    | general   |
| POST   | `/api/grants/:id/revoke`                        | Revoke a grant                                              | general   |
| POST   | `/api/grants/:id/resume`                        | Undo a revoke within 15 seconds                             | general   |

## Connectors

The routes that look a connector up by slug (connect, authorize and the two config routes) search the built-in catalog first, then your custom connectors. `path-suggestions` reads the catalog only.

**What is stored where.** A credential goes to Clawboo's encrypted vault under `connector:<slug>:<KEY>` and is never returned. A launch argument is a plain setting, `connector:<slug>:argument`, so it can be shown back to you. An OAuth sign-in keeps its client registration and tokens in the vault under `connector-oauth-client:<slug>` and `connector-oauth-tokens:<slug>`.

**At startup**, the server reconnects every connector you left connected, as long as it still has what it needs (the same check `POST /api/connectors/connect` makes). A Disconnect keeps a connector down across restarts. On a machine with no saved choice for them, the server also starts the Playwright and Chrome DevTools browser connectors.

### `GET /api/connectors`

Lists the connectors running now. A connector that is defined but not connected is not listed.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  connectors: Array<{
    connectorId: string
    slug: string
    toolCount: number
    tools: string[] // tool names, each prefixed with the slug
    skipped: Array<{ name: string; reason: string }>
    specHash: string
    toolsHash: string
  }>
}
```

`skipped` lists the tools Clawboo could not offer, each with a reason, such as `duplicate-name`. An entry named `(inventory)` with the reason `tool-list-truncated` means the server's tool list could not be read to the end.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl http://localhost:18790/api/connectors
```

### `GET /api/connectors/configured`

One request for the whole shelf: which connectors, built-in and custom, already have what they ask for. Presence only; no value or per-connector detail comes back.

#### Responses

**`200 OK`**:

```ts
{ ok: true; slugs: string[]; supplied: string[] }
```

`slugs` lists every connector whose configuration is complete: required credentials stored, the launch argument present when one is required, and, for a remote connector that signs in with OAuth, a sign-in on file. `supplied` lists every connector you actually gave something to, meaning a stored credential or a stored argument. A connector that asks for nothing is in `slugs` but not in `supplied`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl http://localhost:18790/api/connectors/configured
```

### `GET /api/connectors/path-suggestions`

Real paths to offer as one-click choices for a connector that takes a path argument. Each one is checked on disk before it is offered, so the list can be empty.

- **Query params**: `slug` (required): a built-in connector that takes a path, such as `filesystem` or `sqlite`.

For `sqlite`, the server searches up to two folders deep from the folder you started `clawboo` in, skipping hidden entries and `node_modules` and never following links. It stops looking once it has 25 `.db`, `.sqlite` or `.sqlite3` files, sorts them, and offers the first five, each labelled with its file name. For any other slug it offers, in order, **Where you started clawboo**, then `Documents`, `Desktop` and `Downloads` in your home folder, keeping those that exist. Either way the list holds at most five paths, with no repeats.

The folder you started `clawboo` in comes from `CLAWBOO_LAUNCH_DIR`, which the CLI sets; a development server uses its own working directory.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  suggestions: Array<{ label: string; path: string }>
}
```

**`404 Not Found`**: the slug is missing, is not a built-in connector, or names one that takes no path:

```json
{ "error": "that connector does not take a path" }
```

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl "http://localhost:18790/api/connectors/path-suggestions?slug=filesystem"
```

### `POST /api/connectors/connect`

**Sensitive.** Starts one connector: it spawns the local process, or opens the session to a remote server, and returns the tools the connector offers. Connecting a connector that is already running returns that session. A request that arrives while a connect for the same slug is under way waits for it instead of starting a second process.

Before it starts anything, the server checks, against the vault and the stored settings, that the connector has what it needs. Anything missing answers `422` with a `reason`:

| `reason`                       | Why the connector was refused                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `community-unsandboxed`        | It is a community entry, which nobody has vetted. Add it as a custom connector if you trust it.                                      |
| `remote-needs-registered-app`  | The remote provider needs a pre-registered OAuth app, so Clawboo cannot sign itself in.                                              |
| `remote-needs-oauth`           | A remote connector that signs in with OAuth has no usable sign-in yet.                                                               |
| `needs-credential`             | A required credential is not stored, or a remote connector that takes a token (`bearer`) has none. Optional credentials never block. |
| `needs-user-supplied-argument` | It needs a launch argument, such as a folder or a database file, and none is stored.                                                 |

When several apply, the response names one. For an OAuth connector, an expired token that can be refreshed is refreshed during this check.

- **Request body**:

```ts
{
  slug: string // 1 to 48 characters, lowercase letters, digits and dashes, starting with a letter or digit
}
```

#### Responses

**`200 OK`**: the connector is up:

```ts
{
  ok: true
  connectorId: string
  command: string // the command that actually ran, or the URL of a remote connector
  tools: string[]
  skipped: Array<{ name: string; reason: string }>
}
```

**`400 Bad Request`**: `{ "error": "invalid body", "details": { ... } }`.

**`404 Not Found`**: no built-in or custom connector has that slug:

```json
{ "error": "no catalog connector named <slug>" }
```

**`422 Unprocessable Entity`**: refused, with the reason from the table and a sentence for people:

```json
{ "error": "Sign in to this provider to connect it.", "reason": "remote-needs-oauth" }
```

**`502 Bad Gateway`**: the process or the handshake failed. A failure that never reached the other end is retried first, up to three attempts with a doubling delay; a refusal from the other end is not. `error` names the connector and the likely cause, or reads `<Name> did not start.` when none matches. Likely causes include a missing `npx` or `uvx`, a Node.js that is too old, a package or version that is not published, a rejected key, a missing scope, a timeout, an unreachable host and a missing file. `detail` is the original message, redacted:

```ts
{
  error: string
  detail: string
}
```

Every failure past the checks above is a `502`, never a `500`.

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/connect \
  -H 'Content-Type: application/json' \
  -d '{"slug":"filesystem"}'
```

### `POST /api/connectors/:slug/disconnect`

**Sensitive.** Stops a running connector and records that you want it stopped, so it stays down after a restart. The intent is recorded first, so even a `404` has marked an existing connector as disconnected. If a connect for the same slug is under way, the route waits for it to finish before it decides.

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`404 Not Found`**: nothing with that slug was running:

```json
{ "error": "connector is not connected" }
```

**`500 Internal Server Error`**: stopping it failed, `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/filesystem/disconnect
```

### `POST /api/connectors/:slug/authorize`

**Sensitive.** Starts an OAuth sign-in for a remote connector and returns the URL to open. The server opens nothing itself, because it may not be on the machine with the browser. No credential of yours is involved: Clawboo finds the provider's authorization server and registers itself with it. The provider redirects back to a short-lived listener on `http://127.0.0.1:<port>/callback`, never to a route under `/api`. The port is any free port, except that the port of an earlier registration for this connector is tried first, so that registration can be reused.

Starting a sign-in cancels any earlier pending one for the same connector, so at most one is pending per connector. The discovery and registration steps are tried up to three times in all, with a delay that starts at 300 ms and doubles, but only for failures that never reached the provider.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  authorizeUrl: string
}
```

**`400 Bad Request`**: a local connector has nothing to sign in to:

```json
{ "error": "only remote connectors sign in" }
```

**`404 Not Found`**: `{ "error": "no such connector" }`.

**`502 Bad Gateway`**: every other failure, which is almost always at the provider. Both messages name the connector:

```ts
// the request never left this machine
{
  error: 'Could not reach <Name>. The request did not leave this machine, so this is network rather than the connector.'
}
// anything else, for example a provider without dynamic client registration
{
  error: '<Name> could not start sign-in. <detail>'
} // detail redacted, at most 200 characters
```

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/linear/authorize
```

### `POST /api/connectors/:slug/authorize/await`

Waits until the sign-in started by `POST /api/connectors/:slug/authorize` finishes, so the browser can open the URL first and wait afterwards. The listener gives up 5 minutes after the sign-in started, so this request returns within about 5 minutes. Two callers waiting on the same sign-in get the same answer.

`200` means the provider's code was exchanged and the tokens are stored, not only that the redirect arrived. Everything else is a `400`.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  authorized: true
}
```

**`400 Bad Request`**: the sign-in did not complete. The message keeps its `Error: ` prefix:

| `error`                                               | Cause                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Error: no sign-in is in progress for this connector` | No pending sign-in: `authorize` was never called, or the sign-in already ended |
| `Error: timed out waiting for the sign-in to finish`  | No callback within 5 minutes                                                   |
| `Error: authorization failed: <code>`                 | The provider redirected back with an `error` parameter                         |
| `Error: callback missing code or state`               | The callback came without an authorization code                                |
| `Error: state mismatch, authorization refused`        | The callback's `state` did not match this sign-in                              |

A failure in the token exchange comes back here too, with that exchange's own message.

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/linear/authorize/await
```

### `DELETE /api/connectors/:slug/authorize`

**Sensitive.** Signs a connector out, in this order:

1. Cancels a sign-in that is still pending, so it cannot finish and store new tokens.
2. Stops the connector if it is running, and marks it disconnected.
3. Deletes the stored client registration and tokens.

It looks nothing up, so it answers `200` for any slug, whether or not anything was stored or running.

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`500 Internal Server Error`**: stopping the connector or deleting the tokens failed, `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X DELETE http://localhost:18790/api/connectors/linear/authorize
```

### `GET /api/connectors/:slug/config`

Everything a connector needs before it can run, and whether you have supplied it. Credentials come back as a `present` flag only; the launch argument comes back in full, so you can check which folder or file a connector was given.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  credentials: Array<{
    key: string // the variable name, for example NOTION_TOKEN
    label?: string
    description: string
    required: boolean
    secret: boolean
    present: boolean // a value is stored; the value is never returned
    docsUrl?: string
  }>
  argument: string | null // the stored launch argument; null when none or empty
  argumentSpec: {
    label: string
    description: string
    example: string
    replacesArg?: string
  } | null // null when the connector takes no launch argument
  authorized: boolean
  satisfied: boolean
}
```

`authorized` is the OAuth question. Only a remote connector that signs in with OAuth can answer `false`; every other connector reports `true`. `satisfied` is `true` when every required credential is stored, a required launch argument is present, and `authorized` is `true`. A connector that declares an argument without requiring it is satisfied without one.

**`404 Not Found`**: `{ "error": "no such connector" }`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl http://localhost:18790/api/connectors/filesystem/config
```

### `PUT /api/connectors/:slug/config`

**Sensitive.** Stores the credentials and the launch argument for one connector. These are your own credentials for the connector itself, entered once; a Composio key goes through `PUT /api/connectors/composio/key` instead.

The slug is checked before the body, so an unknown slug is a `404` even when the body is also invalid. The whole body is then checked before anything is written, so a rejected request stores nothing.

- **Request body**: both fields are optional, and an empty object returns the current state unchanged.

| Field      | Type                     | Notes                                                                                                                                            |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `argument` | string, up to 4096 chars | The launch argument, for example a folder or a database file. Trimmed before it is stored; an empty string clears it.                            |
| `values`   | object of strings        | Credential values by variable name. Each key must match `^[A-Z][A-Z0-9_]*$` and be declared by this connector; each value is at most 8192 chars. |

Each credential value is cleaned the way the dashboard's field cleans a paste. Surrounding whitespace is trimmed, a leading `Bearer`, `Token` or `Basic` is removed, and matching quotes or backticks around the value are unwrapped, repeatedly. A value that cleans down to nothing clears that credential.

#### Responses

**`200 OK`**: the state after the write, in the same shape `GET` returns, so a secret sent here cannot be read back.

**`400 Bad Request`**: `{ "error": "invalid body", "details": ... }` for a body that fails validation, including a badly formed key or a value over the limit.

**`400 Bad Request`**: a well-formed key that this connector does not declare:

```json
{ "error": "<KEY> is not declared by <slug>" }
```

**`404 Not Found`**: `{ "error": "no such connector" }`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X PUT http://localhost:18790/api/connectors/filesystem/config \
  -H 'Content-Type: application/json' \
  -d '{"argument":"/Users/me/projects"}'

curl -X PUT http://localhost:18790/api/connectors/notion/config \
  -H 'Content-Type: application/json' \
  -d '{"values":{"NOTION_TOKEN":"ntn_..."}}'
```

## Composio

Composio is the broker Clawboo uses for apps it cannot sign in to directly, such as Gmail or Slack. These routes are about your Composio account and which of its apps you have linked. The apps' own tokens are exchanged at Composio and never reach Clawboo.

The credential is a Composio project API key, the one that starts with `ak_` on your Composio project settings page. Clawboo keeps it in the encrypted vault under `COMPOSIO_API_KEY`, and no response returns it: the only fact any route reports about it is `hasKey`. One install is one Composio user (the fixed id `clawboo-local`).

### `GET /api/connectors/composio`

Whether a key is stored, and which brokered apps are linked. With a key stored, the server asks Composio for the linked apps when its cached answer is more than 60 seconds old.

#### Responses

**`200 OK`**, no key stored:

```json
{ "ok": true, "hasKey": false, "known": true, "connected": [] }
```

**`200 OK`**, a key is stored:

```ts
{ ok: true; hasKey: true; known: boolean; connected: string[]; keyRejected: boolean }
```

`connected` holds Clawboo's slugs for the linked apps. `known` is `false` until Composio has answered at least once, so an empty `connected` with `known: false` means "not known yet", not "nothing linked". `keyRejected` is `true` when Composio refused the stored key (`401` or `403`) on its last use.

**`502 Bad Gateway`**: reading the linked apps failed; the message is redacted and cut to 200 characters:

```json
{ "error": "Could not read connected apps. <message>" }
```

#### Example

```bash
curl http://localhost:18790/api/connectors/composio
```

### `PUT /api/connectors/composio/key`

**Sensitive.** Stores your Composio API key. The paste is unwrapped first, so `COMPOSIO_API_KEY=ak_...`, an `export` line and a quoted value all work. The key is then tried against Composio: a key Composio refuses is not stored, and a key that could not be checked because Composio was unreachable is stored with `verified: false`. Storing a key clears the cached list of linked apps.

- **Request body**: `{ "apiKey": string }`, at most 512 characters.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  hasKey: true
  verified: boolean
}
```

**`400 Bad Request`**: the body has no usable `apiKey` string: `{ "error": "invalid body" }`.

**`400 Bad Request`**: the paste is not a project key (`ak_` followed by at least ten more letters, digits, `_` or `-`). The message is one of:

- `Paste your Composio key.` (an empty value)
- `That is a Composio login key. The one needed here starts with ak_ and is on your project settings page.` (a `uak_` key)
- `That does not look like a Composio key. It starts with ak_.` (anything else)

**`400 Bad Request`**: Composio refused the key, so nothing was stored:

```json
{ "error": "Composio rejected that key. Copy it again from your project settings." }
```

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted and cut to 200 characters.

#### Example

```bash
curl -X PUT http://localhost:18790/api/connectors/composio/key \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"ak_xxxxxxxxxxxx"}'
```

### `DELETE /api/connectors/composio/key`

**Sensitive.** Forgets the stored key and clears the cached list of linked apps. The app links stay at Composio, but Clawboo cannot reach them without a key. Answers `200` whether or not a key was stored.

#### Responses

**`200 OK`**: `{ "ok": true, "hasKey": false }`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted and cut to 200 characters.

#### Example

```bash
curl -X DELETE http://localhost:18790/api/connectors/composio/key
```

### `POST /api/connectors/composio/apps/:slug/authorize`

**Sensitive.** Starts linking one app through Composio and returns Composio's consent URL for the browser to open. The stored key is checked before the slug, so an unknown app with no key stored answers `409`, not `404`. The route refreshes the linked-app list first, so an app that is already linked returns without starting a second consent.

- **Path params**: `slug`, Clawboo's slug for the app, for example `gmail`, `slack` or `google-calendar` (not Composio's own toolkit name, which for the last one is `googlecalendar`).

#### Responses

**`200 OK`**, already linked: `{ "ok": true, "alreadyConnected": true }`.

**`200 OK`**, a consent was started; open `url` in a browser:

```ts
{
  ok: true
  url: string
}
```

**`409 Conflict`**: no Composio key is stored:

```json
{ "error": "Add a Composio key first.", "reason": "no-key" }
```

**`404 Not Found`**: `{ "error": "no brokered app named <slug>" }`.

**`502 Bad Gateway`**: Composio refused or failed the request, or answered without a consent URL (then the trailing detail is absent):

```json
{ "error": "<App name> could not be connected. <detail>" }
```

**`500 Internal Server Error`**: `{ "error": "Could not connect this app. <message>" }`, redacted and cut to 200 characters.

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/composio/apps/gmail/authorize
```

## Custom connectors

A custom connector is a local MCP server you point Clawboo at yourself: a command and its arguments. Definitions are stored in the `connectors:custom` setting, not in the built-in catalog, and come back in the same shape as a catalog entry with `provenance: 'custom'`. Clawboo has not run or reviewed them, so it treats them at their riskiest. Every declared input is a secret, outbound access is unrestricted (`egressAllow: ['*']`), and all three risk flags are set: reads private data, takes in untrusted content, can send data out.

Credential values never go through these routes: declare the variable names here, then store the values with `PUT /api/connectors/:slug/config`.

### `GET /api/connectors/custom`

Lists your custom connectors in storage order.

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  connectors: Array<{
    slug: string
    displayName: string
    description: string // 'A connector you added.' when none was given
    category: 'dev'
    provenance: 'custom'
    launch: {
      transport: 'stdio'
      command: string
      args: string[]
      pinnedVersion: string // the version you were shown, else 'user-supplied'
    }
    auth:
      | {
          kind: 'api-key'
          inputs: Array<{ key: string; description: string; required: boolean; secret: true }>
        }
      | { kind: 'none'; inputs: [] } // when no authInputs were declared
    egressAllow: ['*']
    trifecta: { readsPrivateData: true; ingestsUntrustedContent: true; canEgress: true } // the three risk flags
    tags: ['custom']
    catalogId?: string
  }>
}
```

An input saved with an empty description comes back as `'Required by this server.'`. Stored data that cannot be read never causes an error. A missing or malformed list reads as empty, and an entry without a string `slug`, a string `command` or an `args` array is left out.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl http://localhost:18790/api/connectors/custom
```

### `POST /api/connectors/custom`

**Sensitive**, because the `command` and `args` it stores become a real process when you connect it. Saving a slug that is already a custom connector replaces it and moves it to the end of the list.

- **Request body**:

| Field           | Type                                    | Default  | Notes                                                                                                                                                    |
| --------------- | --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`          | string                                  | required | 1 to 48 characters: lowercase letters, digits and dashes, starting with a letter or digit. It names the tools and grants.                                |
| `displayName`   | string                                  | required | 1 to 80 characters                                                                                                                                       |
| `description`   | string                                  | none     | Up to 300 characters                                                                                                                                     |
| `command`       | string                                  | required | 1 to 1024 characters                                                                                                                                     |
| `args`          | string array                            | `[]`     | Up to 64 entries of up to 2048 characters. An array, so nothing is passed through a shell.                                                               |
| `authInputs`    | `Array<{ key, description, required }>` | `[]`     | Up to 16. `key` is a variable name (`^[A-Za-z_][A-Za-z0-9_]*$`, up to 64 chars); `description` up to 300 chars, default `''`; `required` default `true`. |
| `catalogId`     | string                                  | none     | Up to 200 characters: the registry id, when the entry came from the community list                                                                       |
| `pinnedVersion` | string                                  | none     | Up to 64 characters: the exact version you were shown before you approved it                                                                             |

#### Responses

**`200 OK`**:

```ts
{
  ok: true
  slug: string
}
```

**`400 Bad Request`**: `{ "error": "invalid body", "details": ... }`.

**`409 Conflict`**: the slug belongs to a built-in connector, which a custom entry may not replace:

```json
{ "error": "<slug> is already a catalog connector" }
```

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/custom \
  -H 'Content-Type: application/json' \
  -d '{
        "slug": "my-notes",
        "displayName": "My Notes",
        "command": "node",
        "args": ["/Users/me/servers/notes/index.js"],
        "authInputs": [{ "key": "NOTES_API_KEY", "description": "Key for the notes server", "required": true }]
      }'
```

### `DELETE /api/connectors/custom/:slug`

**Sensitive.** Removes a custom connector. It stops the connector first, if it is running, so no process is left behind with nothing that knows how to stop it. The stop runs on every call, so a `404` means only that no stored definition had that slug.

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`404 Not Found`**: `{ "error": "no such custom connector" }`.

**`500 Internal Server Error`**: stopping it or saving the list failed, `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X DELETE http://localhost:18790/api/connectors/custom/my-notes
```

## Grants

A grant says that a subject (one agent, one team, or every agent) may use a capability (a connector, a tool or a skill) in a given mode, under a given approval policy. Clawboo's connector gate reads grants before a connector tool runs, and the graphs draw your grants as edges. A grant's `origin` is `owner` when it records what an agent's own runtime already attaches, and `operator` when a person shared the capability. Only `operator` grants are drawn with a **Detach** control.

These routes read and write the local database only, and need no credential.

```ts
interface GrantRow {
  id: string
  subjectKind: 'agent' | 'team' | 'global'
  subjectId: string | null // null for 'global'
  capabilityKind: 'connector' | 'tool' | 'skill'
  connectorId: string | null
  capabilityId: string | null
  toolAllow: string[] // tool-name patterns; ['*'] is every tool, [] is none
  toolDeny: string[] // checked first; a denied name is out of scope even if allowed
  mode: 'read' | 'write' | 'admin'
  approvalPolicy: 'never' | 'risk' | 'writes' | 'always'
  state: 'proposed' | 'active' | 'suspended' | 'revoked' | 'expired'
  expiresAt: number | null
  specHashPin: string | null // when set, calls are denied once the connector's spec differs from it
  toolsHashPin: string | null // the same, for the connector's tool list
  callCeilingPerHour: number | null
  origin: 'owner' | 'operator'
  grantedBy: string | null
  grantedAt: number
  revokedAt: number | null
  revokedReason: string | null
}
```

| `approvalPolicy` | When a tool call asks a person first                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `always`         | Every call                                                             |
| `writes`         | Calls to tools that change something                                   |
| `risk` (default) | Calls to destructive tools, and to outside tools that change something |
| `never`          | The policy never asks                                                  |

Some calls ask whatever the policy says, for example in a run that combines private data, untrusted content and a way to send data out. A standing rule from an **Always** answer is checked before the policy, so a tool remembered that way runs without asking even under `always`; revoking the grant deletes those rules. A tool whose required mode ranks above the grant's `mode` is denied. A stored value that cannot be read falls back to its safest reading: `mode` reads as `read`, `state` as `suspended`, `approvalPolicy` as `always`, an unreadable `toolAllow` as `[]` and an unreadable `toolDeny` as `['*']`.

### `GET /api/grants`

Lists grants, newest `grantedAt` first, with no limit.

- **Query params**: `subjectId` (optional): only grants whose subject id equals it, whatever the `subjectKind`. A `global` grant has no subject id, so it never matches. An empty or repeated `subjectId` is ignored and the full list returned.

#### Responses

**`200 OK`**: `{ ok: true, grants: GrantRow[] }`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl "http://localhost:18790/api/grants?subjectId=<agent-id>"
```

### `POST /api/grants`

Creates a grant, or updates the existing grant for the same subject and capability. An update sets `state` back to `active`, clears `revokedAt` and `revokedReason`, and moves `grantedAt` to now. Grants made here have `origin: 'operator'`, and updating an `owner` grant turns it into an `operator` one. The server has no caller identity, so a new grant records `grantedBy: null`.

- **Request body**:

| Field                | Type                                        | Default on create | Notes                                                                                                       |
| -------------------- | ------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `subjectKind`        | `'agent' \| 'team' \| 'global'`             | required          | Who the grant is for                                                                                        |
| `subjectId`          | `string \| null`                            | `null`            | Required unless `subjectKind` is `global`                                                                   |
| `capabilityKind`     | `'connector' \| 'tool' \| 'skill'`          | required          |                                                                                                             |
| `connectorId`        | `string \| null`                            | `null`            | Give `connectorId` or `capabilityId`. With `connectorId`, the stored `capabilityId` is `null`.              |
| `capabilityId`       | `string \| null`                            | `null`            | Used only when there is no `connectorId`                                                                    |
| `mode`               | `'read' \| 'write' \| 'admin'`              | `'read'`          | Left as is on an update when omitted                                                                        |
| `approvalPolicy`     | `'never' \| 'risk' \| 'writes' \| 'always'` | `'risk'`          | Left as is on an update when omitted                                                                        |
| `toolAllow`          | `string[]`                                  | `['*']`           | `[]` means no tools, which differs from leaving the field out                                               |
| `toolDeny`           | `string[]`                                  | `[]`              |                                                                                                             |
| `expiresAt`          | `number \| null`                            | none              | Positive whole epoch ms, or `null`. Only applied when present, so leaving it out never clears a time limit. |
| `callCeilingPerHour` | `number \| null`                            | none              | Positive whole number, or `null`. Only applied when present.                                                |

#### Responses

**`200 OK`**: `{ ok: true, grant: GrantRow }`.

**`400 Bad Request`**: `{ "error": "invalid body", "details": ... }`. The two cross-field rules ("one of connectorId or capabilityId is required" and "subjectId is required unless subjectKind is global") appear in `details.formErrors`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X POST http://localhost:18790/api/grants \
  -H 'Content-Type: application/json' \
  -d '{"subjectKind":"agent","subjectId":"<agent-id>","capabilityKind":"connector","connectorId":"github","mode":"read","approvalPolicy":"risk"}'
```

### `POST /api/grants/:id/revoke`

Revokes a grant and deletes the standing rules recorded against it, so a remembered **Always** cannot outlive the grant. Only an `active` grant changes state; for a grant in any other state the route still answers `200` with the grant as it stands. The standing rules are deleted whatever the state.

- **Request body**: optional, `{ "reason": string | null }` (up to 200 characters). A missing or invalid body is not an error: `reason` is then `null`. The dashboard's **Detach** sends no body.

#### Responses

**`200 OK`**: the grant as it now stands, `{ ok: true, grant: GrantRow }`.

**`404 Not Found`**: `{ "error": "grant not found" }`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X POST http://localhost:18790/api/grants/<grant-id>/revoke \
  -H 'Content-Type: application/json' \
  -d '{"reason":"detached from the graph"}'
```

### `POST /api/grants/:id/resume`

Undoes a revoke within 15 seconds of `revokedAt`, the window behind the dashboard's **Undo**. It sets the grant back to `active` and clears `revokedAt` and `revokedReason`, but the standing rules the revoke deleted stay deleted. An `active` grant comes back unchanged. Takes no body.

#### Responses

**`200 OK`**: the resumed, or already active, grant: `{ ok: true, grant: GrantRow }`.

**`409 Conflict`**: the grant exists but cannot be resumed: the 15 seconds have passed, it has no `revokedAt`, or it is `proposed`, `suspended` or `expired`:

```json
{ "error": "the undo window has closed" }
```

**`404 Not Found`**: `{ "error": "grant not found" }`.

**`500 Internal Server Error`**: `{ "error": "<message>" }`, redacted.

#### Example

```bash
curl -X POST http://localhost:18790/api/grants/<grant-id>/resume
```

**Source of truth:** `apps/web/server/api/connectors.ts`, `composio.ts` and `grants.ts`; request schemas in `packages/db/src/grants/connectorSchemas.ts` and `packages/db/src/grants/schemas.ts`; the refusal reasons in `packages/connector-catalog/src/connectable.ts`; the grant decision in `packages/governance/src/grants/decide.ts`.

## Related

- [Connect an MCP server](/using/connectors): the Connectors panel over these routes
- [Capabilities API](/reference/rest-api/capabilities): connectors and grants as capability records
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): tool approvals and the audit trail
- [What agents can do](/concepts/permissions): what agents can reach, and what is not sandboxed
- [Security](/operating/security): the access token and exposing Clawboo beyond this machine
