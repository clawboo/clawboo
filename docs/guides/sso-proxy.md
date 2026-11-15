---
title: 'Run Clawboo behind a sign-in proxy'
sidebarTitle: 'Sign-in proxy'
description: 'Put Clawboo behind an SSO reverse proxy that signs identity tokens, so each request names the person who sent it, approvals, chat messages and task moves record who did them, and the role in each token can decide what that person may do.'
keywords:
  [
    'SSO',
    'single sign-on',
    'sign-in proxy',
    'identity',
    'JWT',
    'JWKS',
    'Cloudflare Access',
    'oauth2-proxy',
    'who approved',
    'CLAWBOO_PROXY_IDENTITY',
    'proxyIdentity',
    'roles',
    'permissions',
    'CLAWBOO_PROXY_IDENTITY_ROLES',
    'proxyIdentityRoles',
  ]
---

Put a sign-in proxy such as Cloudflare Access or oauth2-proxy in front of Clawboo, and Clawboo can check the signed identity token the proxy sends with each request. It then records who answered an approval, who wrote a chat message or a task comment, and who created or moved a task.

This is off by default. Only an administrator turns it on, in the [operator settings file](/operating/deployment#pin-settings-for-everyone) or in environment variables. The dashboard has no switch for it, because an agent can use the dashboard API too.

<Note>

On its own this puts names on what people do. It adds no accounts or permissions: everyone who gets through your proxy can still do everything the dashboard can, and a role from the token is recorded, not enforced. To let that role decide what each person may do, turn on [Roles](#roles).

</Note>

## How it works

1. Your proxy signs each person in, then forwards their requests to Clawboo with a signed token (a JWT) in a header.
2. Clawboo checks the token's signature with the proxy's **public key**, given as the key itself or as the URL of the proxy's key set (a JWKS). Clawboo never holds anything that can sign a token. Agents run as Clawboo's own user account and can read whatever Clawboo can, so a shared secret would let an agent sign a token as anyone.
3. A token that verifies names the person: its `sub` is their id, and it can carry a name and a role. Clawboo records that person on what the request does.
4. A token that is present but does not verify (forged, expired, replayed, or for another request) is refused with `401`. It is never treated as no token at all.

This works beside the [access token](/operating/security#the-access-token), not in place of it: while the access token is on, a request still needs the access cookie too. To use the proxy instead, see [Use the proxy instead of the access token](#use-the-proxy-instead-of-the-access-token).

## Before you begin

- Clawboo already works through your proxy. [Reach Clawboo from another machine](/guides/self-host-securely) covers the proxy setup, the allowlists and the `/api/mcp/` rule.
- You know three things about your proxy's tokens: the issuer (`iss`), the audience (`aud`), and where its public keys are.

## Choose a mode

| `proxyIdentity` | A request with a good token | A request without a token                                              | A request with a bad token |
| --------------- | --------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| `off` (default) | The token is not looked at  | Works as before                                                        | The token is not looked at |
| `on`            | Works, and names the person | Works with the access token, and what it does is recorded with no name | `401`                      |
| `required`      | Works, and names the person | `401`                                                                  | `401`                      |

`required` covers every `/api/` request and the Gateway WebSocket. Pages and static files load without a token, because they hold no data. The one exception is a spawned agent runtime's own call to Clawboo's MCP servers, which the access gate already admits by its attach token: those never come from a person. In `required` mode, local programs that use only the access token, such as `clawboo open` and `curl` with the cookie, are refused too.

Start with `on` to check that names come through, then switch to `required`.

## Choose a binding

| `proxyIdentityBinding` | Use it when                                                                      | A copied token is good for                         |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `request` (default)    | Your proxy signs a fresh token for each request it forwards                      | One request, to one method and path, for seconds   |
| `session`              | Your proxy sends its own sign-in token, as Cloudflare Access and oauth2-proxy do | Any request, until the token expires (often hours) |

With `request` binding every token must carry:

- `htm`, the request's method, and `htu`, its path. Only the path is compared, never the query, and exactly as written: the same letter case, percent-encoding and `.` or `..` segments as the request's. `htu` can also be a full `https` or `http` URL, of which only the path counts; a URL whose path has `.` or `..` segments matches no request. It is the path as Clawboo receives it, after any rewriting your proxy does, so it includes the [path prefix](/guides/self-host-securely#serve-clawboo-under-a-path-prefix) when you use one.
- `iat` and `exp`, with `exp` no more than `proxyIdentityMaxLifetime` seconds after `iat` (60 by default, 300 at most).
- `jti`, a unique id. Clawboo accepts each one once. It remembers them in the server's memory, so a restart forgets them, and two Clawboo servers behind one proxy each accept a token once (see [What it does not protect](#what-it-does-not-protect)).

With `session` binding a token needs only `sub` and `exp`. If it carries `htm` or `htu`, those are still checked.

## Settings

| Operator file key          | Variable                              | Default            | What it sets                                                                        |
| -------------------------- | ------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `proxyIdentity`            | `CLAWBOO_PROXY_IDENTITY`              | `off`              | `off`, `on` or `required`                                                           |
| `proxyIdentityHeader`      | `CLAWBOO_PROXY_IDENTITY_HEADER`       | `clawboo-identity` | The header that carries the token. A `Bearer ` prefix is allowed                    |
| `proxyIdentityJwksUrl`     | `CLAWBOO_PROXY_IDENTITY_JWKS_URL`     | unset              | The proxy's key set. `https`, or plain `http` only to this computer                 |
| `proxyIdentityPublicKey`   | `CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY`   | unset              | The proxy's public key: a PEM public key, a JWK or a JWKS                           |
| `proxyIdentityIssuer`      | `CLAWBOO_PROXY_IDENTITY_ISSUER`       | unset              | The `iss` every token must carry                                                    |
| `proxyIdentityAudience`    | `CLAWBOO_PROXY_IDENTITY_AUDIENCE`     | unset              | The `aud` every token must carry                                                    |
| `proxyIdentityBinding`     | `CLAWBOO_PROXY_IDENTITY_BINDING`      | `request`          | `request` or `session`                                                              |
| `proxyIdentityMaxLifetime` | `CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME` | `60`               | The longest `exp - iat` a request-bound token may have, in seconds, from 1 to 300   |
| `proxyIdentityNameClaim`   | `CLAWBOO_PROXY_IDENTITY_NAME_CLAIM`   | `name`             | The claim with the person's name. Without it, `email`, then `preferred_username`    |
| `proxyIdentityRoleClaim`   | `CLAWBOO_PROXY_IDENTITY_ROLE_CLAIM`   | `role`             | The claim with the person's role. A list is joined with commas                      |
| `proxyIdentityRoles`       | `CLAWBOO_PROXY_IDENTITY_ROLES`        | `off`              | `off`, or `enforce` to let the role decide what the person may do ([Roles](#roles)) |

Set exactly one of `proxyIdentityJwksUrl` and `proxyIdentityPublicKey`, and both the issuer and the audience. Without the audience, a token your sign-in provider made for any other app would do. A claim name can be a dotted path into the token, such as `realm_access.roles`. In an environment variable, a PEM key can be written on one line with `\n` for each line break.

Clawboo reads these once at startup. When the lane is on but cannot be trusted, the server logs `CONFIG: refusing to start.` with the reason and exits with code 1. That happens when there is no key, both keys, no issuer or no audience; when the key is a private key, a shared (HMAC) key, an RSA key shorter than 2048 bits, or not a key; when the JWKS URL is plain `http` to another computer; when the header is one Clawboo or a browser already uses, such as `cookie` or `host`; or when `proxyIdentityRoles` is `enforce` and `proxyIdentity` is not `required`.

**Keep these settings out of agents' reach.** Agents run as the same user as Clawboo, so an agent that can change these settings can put in its own key and sign in as anyone after the next restart. Set the variables in your service manager, or keep the operator file somewhere that user can read but not change, such as a root-owned `/etc/clawboo/operator.json`: the file and every folder above it owned by another user, and none of them writable by Clawboo's user, except a sticky folder such as `/tmp`, which lets a user rename only what it owns. When the settings come from a file Clawboo's user owns, can write, or can replace through a folder above it, the server logs a `SECURITY:` warning at startup. On Windows, Clawboo cannot check who can change a file (Node reads neither owners nor access lists there), so it logs that warning whenever these settings come from the operator file. Let only administrators change the file, or set the variables in the service's environment.

## Set it up

<Tabs>

<Tab title="Cloudflare Access">

Cloudflare Access sends its own sign-in token on every request, in the `Cf-Access-Jwt-Assertion` header. In the Zero Trust dashboard, open your Access application and copy its **Application Audience (AUD) Tag**. Your team domain is `<team-name>.cloudflareaccess.com`.

```json
{
  "proxyIdentity": "required",
  "proxyIdentityHeader": "Cf-Access-Jwt-Assertion",
  "proxyIdentityJwksUrl": "https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs",
  "proxyIdentityIssuer": "https://<team-name>.cloudflareaccess.com",
  "proxyIdentityAudience": "<your AUD tag>",
  "proxyIdentityBinding": "session"
}
```

Access tokens carry the person's email but no name, so the email becomes the name. A service token has no subject, so requests made with one are refused.

</Tab>

<Tab title="oauth2-proxy">

oauth2-proxy can forward the ID token your sign-in provider issued, as `Authorization: Bearer <token>`, when you start it with `--pass-authorization-header`. The keys, issuer and audience are your provider's: the `jwks_uri` and `issuer` from its OpenID configuration, and usually your OAuth client ID as the audience. For Keycloak, for example:

```json
{
  "proxyIdentity": "required",
  "proxyIdentityHeader": "authorization",
  "proxyIdentityJwksUrl": "https://sso.example.com/realms/team/protocol/openid-connect/certs",
  "proxyIdentityIssuer": "https://sso.example.com/realms/team",
  "proxyIdentityAudience": "<your OAuth client ID>",
  "proxyIdentityBinding": "session",
  "proxyIdentityRoleClaim": "realm_access.roles"
}
```

ID tokens expire, often after an hour. If requests start failing with the reason `expired`, have oauth2-proxy refresh its session (`--cookie-refresh`) more often than the token expires.

</Tab>

<Tab title="Your own proxy">

A proxy you control can sign a short-lived token for each request, which is the strongest setup. Give Clawboo the public half of an Ed25519 key pair and keep the private half with the proxy only:

```bash
openssl genpkey -algorithm ed25519 -out proxy-signing.pem
openssl pkey -in proxy-signing.pem -pubout -out proxy-public.pem
```

```json
{
  "proxyIdentity": "required",
  "proxyIdentityPublicKey": "-----BEGIN PUBLIC KEY-----\n<the key>\n-----END PUBLIC KEY-----",
  "proxyIdentityIssuer": "https://sso.example.com",
  "proxyIdentityAudience": "clawboo"
}
```

For each request, sign a token with `alg` `EdDSA` and send it in the `clawboo-identity` header. Its claims, for `POST /api/tools/approvals/<id>/resolve`:

```json
{
  "iss": "https://sso.example.com",
  "aud": "clawboo",
  "sub": "user-42",
  "name": "Ada Lovelace",
  "role": "admin",
  "iat": 1793880000,
  "exp": 1793880030,
  "jti": "5b0f9c1e-8f8e-4d7a-9a51-2f4f0c3c6d21",
  "htm": "POST",
  "htu": "/api/tools/approvals/<id>/resolve"
}
```

ES256 and RS256 work too, and a JWKS with several keys lets you rotate them. Sign the WebSocket upgrade as well: `GET` and `/api/gateway/ws`.

</Tab>

</Tabs>

Then restart Clawboo (`clawboo restart`, or your service manager). The startup log says `Proxy identity lane on` with the mode, the binding and where the keys come from.

## Check that it works

`GET /api/access/identity` answers with the lane's mode and the person the request's token names. Open it in your browser through the proxy, at `https://dash.example.com/api/access/identity`:

```json
{
  "proxyIdentity": "required",
  "appLink": false,
  "roles": "off",
  "person": { "id": "user-42", "name": "Ada Lovelace", "role": "admin" }
}
```

`person` is `null` for a request that carried no token while the lane is `on`. **Settings** > **System** > **Deployment** shows the mode under **Sign-in proxy**, set by your administrator.

## What gets recorded

The person is `{ "id", "name", "role" }`, taken from the token. It is recorded only when a token verified; nothing in a request body can supply one.

| What a person did                                                              | Where the person is recorded                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answered an approval card from the dashboard                                   | `resolvedBy` on the approval and on its [`approval_resolved`](/reference/events-and-errors#approval_resolved) event. For an OpenClaw command, once the Gateway takes the answer |
| Answered an OpenClaw approval the dashboard reports to `/api/approvals`        | `resolvedBy` in the record's `details`; a `resolvedBy` the browser sends is dropped                                                                                             |
| Wrote in team chat or a chat room, or in a 1:1 chat with an agent Clawboo runs | `person` on the message                                                                                                                                                         |
| Created, moved, assigned, retried, claimed or linked a task                    | `person` on the board event                                                                                                                                                     |
| Commented on a task                                                            | `person` on the comment and on its `comment_added` event                                                                                                                        |

When the Gateway's own broadcast settles an OpenClaw approval before Clawboo hears back, its event goes out without a name; the approval itself still records who answered. A name can be missing; it is never a guess.

## Roles

With `proxyIdentityRoles` set to `enforce`, the role in each token decides what its person may do. It needs `proxyIdentity` set to `required`, so that every request names a person; the server refuses to start otherwise. Your proxy names the role in the role claim (`role` unless you set `proxyIdentityRoleClaim`).

| Role       | What the person may do                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`    | See and do the work, answer approvals, answer one with "Allow always", see the connected accounts and remove access, and read the audit log and the approval history                                                                            |
| `operator` | See and do the work, set up agents, teams, routines, rules, connectors and skills, see costs and budgets, run the server (providers, keys, runtimes, settings, updates), and read the records. Never answer an approval or make agents ask less |
| `member`   | See and do the work. Answer approvals, allowing once or denying, only when the token also says `"approve": true`                                                                                                                                |
| `guest`    | See and do the work of the teams the token lists, and only until its `access_until`. Never answer an approval                                                                                                                                   |

Seeing and doing the work covers the teams, agents, board, chats, rooms, task folders and memory: asking an agent or a team for work, writing and moving tasks, commenting, answering an agent's question, and pausing or stopping work.

- **Roles add up.** A role claim that lists `owner` and `operator` gets what both get. A word Clawboo does not know, such as your provider's `offline_access`, is ignored. A token with no role Clawboo knows reaches only `GET /api/access/identity`, which says so.
- **An answer that lasts is the owner's.** "Allow always" on an approval, and a connector grant made to act without asking (`approvalPolicy: "never"`), need the owner, so an operator can make agents ask more but never less. A grant that never asks needs both roles, owner and operator.
- **A guest's limits** hold while guest is the person's one role. A guest reaches a route that names one of their teams, an agent or a task on one of them, or a chat of one of them, and four lists that Clawboo cuts down to their teams: `GET /api/teams`, `GET /api/agents`, `GET /api/board` and `GET /api/tools/approvals`. What a guest's write names in its body must be on one of their teams too: the parent of a new task, the agent it is for, the task it waits on. Everything else is refused, and so is every request once `access_until` has passed.
- **The Gateway WebSocket** opens only for a person who both runs the server and answers approvals, standing ones included: an `owner` who is an `operator` too. OpenClaw's own commands travel on it, its approvals and "Allow always" among them, and are not checked one by one. Where the owner and the operator are different people, OpenClaw's Gateway is out of reach while roles are enforced.
- **What decides whether anyone is asked needs both roles too.** An agent's command posture (`POST /api/exec-settings`) and OpenClaw's own settings (`PATCH /api/system/openclaw-config`, `POST /api/system/configure-openclaw`, `POST /api/system/auto-configure-openclaw`) can make agents ask less, so they need a person who is owner and operator. Bringing back a revoked grant that never asks needs the owner.
- **A route Clawboo does not list** is the operator's.

The claims beside the role:

| Claim          | Type                          | What it sets                                                                       |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `approve`      | boolean                       | A member may answer approvals                                                      |
| `teams`        | list of team ids              | The teams a guest reaches: at most 64 ids of at most 128 characters. None: no team |
| `access_until` | seconds since 1970 (a number) | When a guest's access ends. Not the token's own `exp`                              |
| `roleLabel`    | text                          | How the person's role reads on screen, such as Expert. Never used for a decision   |
| `svc`          | boolean                       | The token is a program's, not a person's (see below)                               |
| `rv`           | `1`                           | The version of these claims. Left out, it reads as 1                               |

The whole token may take at most 16 KiB. A claim that is there but malformed refuses the token with `claims`, as any bad token is: a `teams` that is not a list of ids, or lists more than 64, an `approve` or `svc` that is not true or false, or an `rv` this version of Clawboo does not know. For a guest, a `teams` left out or empty reaches no team.

**A service token** (`"svc": true`) is for a program of your sign-in front's own, such as its health checks or its scheduler, rather than for a person. It gets its role's permissions, but it is never a person: nothing records it as one, every write that needs a person refuses it, and it never answers or makes an approval, whatever its role. It never opens the Gateway WebSocket. While roles are off, `svc` is not read.

**The app link** follows the same rules: with roles enforced, its tokens need a role claim too, or they reach only `GET /api/access/identity`. An app that sends none, as the desktop app does today, cannot use its link to an install that enforces roles.

A refused request gets `403`:

```json
{
  "ok": false,
  "error": "role",
  "reason": "not-allowed",
  "message": "Your role in this workspace does not allow this."
}
```

| `reason`        | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `no-role`       | The token names no role Clawboo knows                                                         |
| `not-allowed`   | The person's roles do not allow this route, or what its body asks for, such as "Allow always" |
| `outside-teams` | A guest asked for something outside their teams                                               |
| `ended`         | A guest's `access_until` has passed                                                           |
| `person`        | No verified person, on a route that needs one                                                 |

`GET /api/access/identity` then answers `"roles": "enforce"` and what this person may do:

```json
{
  "proxyIdentity": "required",
  "appLink": false,
  "roles": "enforce",
  "person": { "id": "user-7", "name": "Grace Hopper", "role": "guest" },
  "access": {
    "roles": ["guest"],
    "label": "Expert",
    "permissions": ["see", "work"],
    "guest": true,
    "teams": ["3f2c9a10-6b1e-4c4e-9a7d-2f0a51c8e6b4"],
    "accessUntil": 1795132800,
    "ended": false,
    "service": false
  }
}
```

With roles enforced the answer also carries `"service"`: the program a service token names, else `null`.

The dashboard does not yet hide what a role cannot use: an action the role does not allow fails when someone tries it.

The roles are checked on every request through Clawboo's API. They do not keep an agent that runs as Clawboo's own user away from its database: set [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) for that, and see [What it does not protect](#what-it-does-not-protect).

## Use the proxy instead of the access token

With `proxyIdentity` set to `required`, you can turn the access token off with `STUDIO_ACCESS_TOKEN=` (set blank). Your proxy is then the only way in: every `/api/` request and the Gateway WebSocket need a token that verifies, and agents' own MCP calls still work by their attach token. This fits the default loopback bind behind a proxy on the same machine. A network bind (`HOST=0.0.0.0`) with the access token off still refuses to start.

## What it does not protect

- **Without roles it is not access control.** Anyone who gets through your proxy can do everything the dashboard can, and a role is only recorded. With [Roles](#roles) enforced, the role decides what each person may do through the API.
- **The records live in Clawboo's database.** Agents and other programs running as Clawboo's user can change the database and its files directly. The records say who did what through the dashboard; they are not a tamper-proof audit log.
- **In `on` mode, the access token still works.** Agents can read the access token file, so anything running as Clawboo's user can still act through the API, with no name recorded. Use `required` to refuse such requests.
- **A token someone copies works for its lifetime.** With `session` binding that can be hours, on any path. With `request` binding it is once, for one request, within seconds, per Clawboo server: the list of used tokens is kept in memory, so a token used just before a restart works once more after it until it expires, and so does one sent to a second server behind the same proxy. Clawboo never logs tokens, but your proxy's logs might.
- **An agent that can use your signed-in browser can act as you.** If an agent drives a browser profile that is signed in to your proxy, its requests carry your token.
- **The proxy must be the only way in from outside.** A request that reaches Clawboo without passing the proxy carries no token, which `required` refuses and `on` lets through unnamed.
- **Some actions carry no name.** OpenClaw agents' 1:1 chat and everything else sent over the Gateway WebSocket (the connection is checked when it opens, but the messages on it are not), edits to a task's title, description or priority, and work started by routines.
- **Clocks must agree.** Clawboo allows 5 seconds of difference between its clock and the proxy's.

## An app that starts Clawboo

An app that starts Clawboo itself, such as the desktop app, can name its own people too, beside a sign-in proxy or without one. It hands Clawboo its public key in [`CLAWBOO_APP_LINK_PUBLIC_KEY`](/reference/environment-variables#clawboo_app_link_public_key) when it starts it, and signs a token for each request it sends on someone's behalf:

- in the `clawboo-app-identity` header, with or without a `Bearer ` prefix;
- signed with `EdDSA` (Ed25519);
- `iss` `clawboo-app-link` and `aud` `clawboo-engine`;
- `sub` the person's id, which must start with `account:` and have more after it, and an optional `name`;
- request-bound, always: `htm`, `htu`, `iat`, `exp` at most 60 seconds after `iat`, and a `jti` it never reuses.

A good token makes the request that person's, exactly as a proxy's token does: it passes [the person check](/operating/security#the-person-check), and the person is recorded on what it does. The two never mix:

- The app's token may name only `account:` people. While the app's key is set, a sign-in proxy's token may not name one. Either is refused with `claims`. A proxy on its own keeps whatever ids it already uses.
- With both on, a request that carries both headers is refused with `two-tokens`. With only one on, the other header is ignored like any other.
- The app's token never makes one required. Requests without it, such as the dashboard's own, work as before, whatever `proxyIdentity` is set to.
- The app's token works only for what the app signs: sending work to an agent (`POST /api/agents/:agentId/chat`) or a team (`POST /api/teams/:id/chat`), answering an approval (`POST /api/tools/approvals/:id/resolve` or `POST /api/capabilities/approve`), and checking its link (`GET /api/access/identity`). On any other route it is refused with `route` before it is checked, so a key copied from the app's computer cannot create grants, change who is asked about what, or change a setting. A Gateway WebSocket upgrade that carries it is refused with `binding`, because messages on that socket are not checked one by one.
- A sign-in proxy on its own may use `clawboo-app-identity` as its header. With the app's key set too, that stops the server at startup.

An app's person may allow an approval once or deny it, but not allow it always: that answer gets `403` with `"error": "allow_always_from_app"`, and the approval stays as it was. The key for this sits on the computer that runs the app, and a standing rule signed with a stolen one would outlast every card the person saw.

`GET /api/access/identity` answers `"appLink": true` when Clawboo has the app's key, so the app can check its link. A request it signed should come back with its person.

## Refusals

A refused request gets `401` with a JSON body. Its `reason` says why:

```json
{
  "error": "Clawboo refused the identity token from your sign-in proxy.",
  "gate": "clawboo-proxy-identity",
  "reason": "expired"
}
```

| `reason`           | Meaning                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `missing`          | No token, in `required` mode (the error reads "Clawboo needs a signed identity token…")                     |
| `two-tokens`       | Both a sign-in proxy's token and an [app's](#an-app-that-starts-clawboo) token on one request, with both on |
| `route`            | An [app's](#an-app-that-starts-clawboo) token on a route the app does not sign for                          |
| `malformed`        | Not a signed token, an empty header, or the header sent twice                                               |
| `algorithm`        | Not signed with an allowed algorithm: unsigned (`alg: none`) and shared-secret (`HS256` and so on) tokens   |
| `signature`        | The signature does not match any of the proxy's keys                                                        |
| `issuer`           | Another `iss`                                                                                               |
| `audience`         | Another `aud`                                                                                               |
| `expired`          | Past its `exp`, or a request-bound token older than the maximum lifetime                                    |
| `not-yet-valid`    | Issued, or valid only, in the future                                                                        |
| `lifetime`         | A request-bound token whose `exp` is too far after its `iat`                                                |
| `binding`          | For another method or path                                                                                  |
| `replayed`         | A request-bound token Clawboo already accepted                                                              |
| `claims`           | A required claim is missing or has the wrong type, such as no `sub`, or a `sub` of the other issuer's kind  |
| `keys-unavailable` | The proxy's key set could not be fetched                                                                    |

A refused WebSocket upgrade gets `401 Unauthorized`. The server logs `Proxy identity: refused a request` with the reason, the method and the path, never the token.

<Accordion title="Under the hood">

- Allowed algorithms: `EdDSA` (Ed25519), `ES256`, `ES384`, `ES512`, `RS256`, `RS384`, `RS512`, `PS256`, `PS384` and `PS512`. The algorithm is checked before any key is looked up, so an unsigned token or one "signed" with the public key as an HMAC secret never reaches a key.
- Tokens are verified with the `jose` library. A key set from a URL is cached for 10 minutes. A token with a key id the cache does not have makes it fetch again, at most once every 30 seconds, and a fetch that takes over 5 seconds fails.
- Clawboo remembers the `jti` of each request-bound token until it expires, up to 100,000 at a time, in the server's memory only. When that many are live, new tokens are refused rather than an old one forgotten.
- The lane runs after the access gate and before any route. It reads a request's path three ways: as sent, with `.` and `..` segments resolved, and as the router matches it. It guards the request when any of them is under `/api/`, in any letter case, so neither `/API/...`, a dot segment nor an absolute-form target such as `GET http://host/api/... HTTP/1.1` steps around it. A runtime's attach token stands in for an identity token only when all three are under `/api/mcp/`. Binding uses the path as sent.
- Names and roles are stripped of control characters and cut to 200 characters. A `sub` longer than 256 characters, with a control character in it or with spaces around it, is refused.

</Accordion>

## Related

- [Reach Clawboo from another machine](/guides/self-host-securely): the proxy itself, the allowlists and the `/api/mcp/` rule.
- [Security model](/operating/security#signed-identity-from-a-sign-in-proxy): what the access token and this lane each protect.
- [Environment variables](/reference/environment-variables#clawboo_proxy_identity): each setting's details.
