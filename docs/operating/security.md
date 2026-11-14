---
title: 'Security model'
sidebarTitle: 'Security'
description: 'What protects a Clawboo install by default, what does not, where your keys are stored, and what changes when you expose the dashboard.'
keywords:
  [
    'security',
    'threat model',
    'access token',
    'access gate',
    'STUDIO_ACCESS_TOKEN',
    'access-token',
    'clawboo open',
    'sign-in link',
    'same-origin guard',
    'vault',
    'reverse proxy',
    'security advisory',
    'sign-in proxy',
    'SSO',
    'CLAWBOO_AGENT_USER',
  ]
---

Clawboo is built for one person on one computer. Out of the box it listens only on that computer and turns away web pages that try to reach it. This page explains what that protects, what it does not, where your keys are stored, and what changes when you open the dashboard to other machines. To set up remote access, follow [Reach Clawboo from another machine](/guides/self-host-securely).

<Warning>

**Security advisory: clawboo 0.5.0 and older behind a reverse proxy.** On these releases the access token does not cover `/api/mcp/`. Any request that reaches Clawboo from `127.0.0.1` skips the access cookie on every `/api/mcp/` path, including `/api/mcp/config`. A reverse proxy on the same machine (nginx, Caddy, a Cloudflare Tunnel connector) delivers every request from `127.0.0.1`. So anyone who can reach the proxy can use Clawboo's MCP servers: your boards, memory, team chat and tools. They can also ask `/api/mcp/config` for an attach URL signed as any of your agents, with that agent's connector grants. This holds even with `STUDIO_ACCESS_TOKEN` set.

If that is your setup, deny all of `/api/mcp/` at the proxy now with the rule below, or upgrade once a release newer than 0.5.0 is out. Run `clawboo --version` to see your version.

</Warning>

<Tabs>

<Tab title="nginx">

```nginx
# Inside the server block that proxies to Clawboo.
location ~* ^/api/mcp(/|$) {
    return 404;
}
```

</Tab>

<Tab title="Caddy">

```caddyfile
# Inside the site block, next to reverse_proxy.
@mcp path /api/mcp /api/mcp/*
respond @mcp 404
```

</Tab>

<Tab title="Cloudflare Tunnel">

```yaml
# config.yml: the deny rule must come before the rule that reaches Clawboo.
ingress:
  - hostname: dash.example.com
    path: '(?i)^/api/mcp(/|$)'
    service: http_status:404
  - hostname: dash.example.com
    service: http://127.0.0.1:18790
  - service: http_status:404
```

</Tab>

</Tabs>

All three rules ignore letter case, because 0.5.0 also routes variants such as `/API/MCP/config`. Under a path prefix, add the same rule for the prefixed path (`/clawboo/api/mcp`), because Clawboo also answers `/api/` without the prefix. Releases after 0.5.0 let a request without the cookie reach the MCP servers only with an attach token (see [The access token](#the-access-token)). Keep the deny rule anyway, as a second layer.

## What is protected by default, and what is not

| Who could reach Clawboo                                                               | Protected by default? | What protects it                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another computer on your network                                                      | Yes                   | Clawboo listens only on `127.0.0.1`                                                                                                                                                                                                                                                                                          |
| A web page open in your browser                                                       | Yes                   | The same-origin guard                                                                                                                                                                                                                                                                                                        |
| Anyone who can reach a reverse proxy in front of Clawboo                              | Yes                   | The access token, unless you turn it off                                                                                                                                                                                                                                                                                     |
| Another user account on the same computer                                             | Yes                   | The access token, and your Clawboo folder, the work folder and the OpenClaw key files Clawboo writes are readable only by you                                                                                                                                                                                                |
| Agents, connectors and other programs running as you                                  | No                    | Nothing in Clawboo can fully stop them (see [What agents can do](#what-agents-can-do-on-your-machine)). With [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) set (releases after 0.6.0), agents other than OpenClaw's run as their own user, which makes the database, vault, key, settings and token a boundary for them |
| One person behind your sign-in proxy passing as another                               | No, off by default    | The [proxy identity lane](#signed-identity-from-a-sign-in-proxy), when an administrator turns it on                                                                                                                                                                                                                          |
| An agent answering its own question, allowing its own wakes or reopening a task       | A speed bump locally  | The board's person-only routes refuse any request that does not pass [the person check](#the-person-check). See [What counts as a person](#what-counts-as-a-person)                                                                                                                                                          |
| A planted note or tool result steering Boo Zero's hand-off to a team you did not name | Yes                   | Work for a team your message did not name waits for your yes on a card (see [Boo Zero](/using/boo-zero#give-a-team-work-from-this-chat))                                                                                                                                                                                     |

Releases after 0.5.0 give every install an access token: without one, anything that reaches Clawboo from `127.0.0.1` looked like you, and could call every `/api/` route, including the ones that answer approvals, grant connector access and start agent runs. The token is in a file only your user account can read, so it closes the API to other user accounts and to anyone behind a reverse proxy. It does not stop a program running as you: an agent can read `~/.clawboo/access-token` as easily as it can read the database. With [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) set, agents other than OpenClaw's run as a separate user that can read neither.

So treat approvals and connector grants as controls against a confused or prompt-injected model, not against other code on your machine. The coding runtimes and connectors Clawboo starts never receive the token, but a program running as you can still read your files, including the token file, Clawboo's database and key vault.

## The loopback bind

Clawboo listens on `127.0.0.1` unless you set `HOST`. `localhost`, `::1` and any `127.x.x.x` address also count as loopback. `HOSTNAME` is ignored, because Docker, systemd and many CI runners set it automatically; widening the bind takes an explicit `HOST`.

To listen on the network, set `HOST=0.0.0.0`. Do not bind one network address such as `HOST=192.168.1.10`. Clawboo's own agents and background jobs connect to `127.0.0.1`, and a single-address bind does not listen there, so agents lose their Clawboo tools and `clawboo` cannot find the server.

A non-loopback bind without a working access token refuses to start: the server logs `SECURITY: refusing to start` and exits with code 1. A default install always has one, so this happens only with the token turned off (`STUDIO_ACCESS_TOKEN=` set blank). On a network, a script can send any `Host` or `Origin` header, so the same-origin guard cannot stop it and the token is the only authentication. `CLAWBOO_ALLOW_INSECURE=1` overrides the refusal and logs a `SECURITY:` warning instead. Use it only on a network where you would leave the dashboard open to everyone.

## The same-origin guard (always on)

The guard stops web pages in your own browser from using Clawboo. Your browser can reach `127.0.0.1`, so without it any site you visit could send requests to the API or open the Gateway WebSocket. The guard checks every `/api/` request and the WebSocket upgrade at `/api/gateway/ws`, with or without an access token:

- **Host** must be `localhost`, a `127.x.x.x` address, `::1`, the bind address, or a name in `CLAWBOO_ALLOWED_HOSTS`. This applies to every request, browser or not. It also blocks DNS rebinding, where an attacker's domain is pointed at `127.0.0.1`.
- **Origin**, when the request has one, must exactly match an allowed origin. Those are `localhost`, `127.0.0.1` and `[::1]` at Clawboo's port (over `http` or `https`), the bind address at that port, and the entries in `CLAWBOO_ALLOWED_ORIGINS`.
- **Sec-Fetch-Site**, when present, must be `same-origin`, `same-site` or `none`.

A rejected request gets `403` with `{"error":"Cross-origin request blocked."}`, and a rejected WebSocket upgrade gets `403 Forbidden`. The dashboard page and its static files are not checked, because they hold no data. A request whose target is a full URL instead of a path gets `400` with `{"error":"Bad request target."}` on every path, or `404` when Clawboo is served under a path prefix (`CLAWBOO_BASE_PATH`), whose check answers first. Browsers, reverse proxies and Clawboo's own clients always send a path.

The two variables take comma-separated lists and only add entries; the loopback entries always stay. When you reach Clawboo by any other name or address, set both: `CLAWBOO_ALLOWED_HOSTS` for the name (`dash.example.com`) and `CLAWBOO_ALLOWED_ORIGINS` for the full origin (`https://dash.example.com`). Without them the dashboard page loads, but every API call fails with the 403 above.

In dev mode (`pnpm dev`), the server also answers CORS requests, with credentials, for the allowed origins only. In dev those include the Vite dev server on port 5173.

The guard is not authentication. A script or `curl` can send any `Host` and `Origin` it likes, which is why a network bind needs the access token.

## The access token

The access token is a shared secret that every `/api/` path (in any letter case) and the Gateway WebSocket require, as the `clawboo_access` cookie. The dashboard page and static files load without it. The server picks its token when it starts, first match wins:

1. **`STUDIO_ACCESS_TOKEN`**, when it is set in the environment. A `studioAccessToken` entry in `settings.json` has no effect.
2. **Nothing, when `STUDIO_ACCESS_TOKEN` is set but blank** (`STUDIO_ACCESS_TOKEN=`). The server then runs with no token and every `/api/` route is open to anything that can reach it. `pnpm dev` runs this way.
3. **The per-install token** in `~/.clawboo/access-token` (it follows `CLAWBOO_HOME`). The first start writes 32 random bytes there as base64url, readable only by you (mode `0600`, in a folder made `0700`). Later starts, and the server an in-app update starts, read the same file, so a signed-in browser stays signed in. The file is one per user account, not per app, so the Clawboo desktop app can use the same token.

Clawboo narrows an existing token file to `0600` before it reads it, and checks and reads it through one open file, so the name cannot be pointed at another file in between. It refuses to start, logging `SECURITY: refusing to start` with the file's path, when the file is a link or not a regular file, stays readable by others, or does not hold a usable token. It also refuses when a new file comes out readable by others, as on a filesystem that ignores permissions, and when there is no home folder to keep it in (it never puts the token in the shared temp folder; set `CLAWBOO_HOME` there). It never overwrites the file; delete it to get a new token on the next start. Releases up to 0.5.0 have no per-install token: without `STUDIO_ACCESS_TOKEN`, the API is open.

<Warning>

**Use only letters, digits, `.`, `_`, `~` and `-` in the token.** With any other character the server refuses to start, on every bind: it logs `SECURITY: refusing to start`, names the character and the allowed set, and exits with code 1. `CLAWBOO_ALLOW_INSECURE=1` does not skip this, because it allows running with no token, not with one the check cannot use. Output from `openssl rand -base64` can contain `+`, `/` or `=`. Generate tokens with `openssl rand -hex 24` and save the value. On 0.5.0 and older, such a token turns the check off and the server keeps running, so behind a reverse proxy on the same machine the dashboard is open.

</Warning>

**Sign in once per browser.** A browser gets the cookie in one of these ways:

- **`clawboo`, `clawboo restart` and `clawboo open`** open your browser with a one-time sign-in link. The terminal shows only the plain address.
- **`clawboo open --print`** prints a one-time link for a browser that `clawboo` cannot open, such as on a computer with no desktop.
- **Open on another device**, at the bottom of the dashboard's sidebar, shows a one-time link and, when the dashboard's address is one a phone can reach, a QR code of it, with a **Copy link** button.
- **Paste a sign-in link**, on the locked screen, takes a one-time link or just its code. This is how an app added to a phone's home screen signs in: on an iPhone or iPad that app keeps its cookies apart from Safari's, and a link you tap opens in Safari instead of the app. Copy the link from **Open on another device**, send it to the phone, and paste it into the app.
- **`?access_token=<token>`** added to any Clawboo address, such as `https://dash.example.com/?access_token=<token>`, signs in with the token itself.

Each sets the cookie and redirects to the same address without the code or token. The cookie is `HttpOnly` and `SameSite=Lax`, its path is `/` (or your `CLAWBOO_BASE_PATH`), and it is `Secure` when the request carries `X-Forwarded-Proto: https`. The WebSocket accepts only the cookie.

A one-time link carries `?access_code=` instead of the token. The code works once, within two minutes, and only on a page address, never on an `/api/` path. A browser loading the link as a page spends it at once (the request's `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`). Browsers send those headers only to an HTTPS or loopback address, so a request without any of them, such as a phone opening a plain-HTTP network address, gets a page with a **Sign in** button instead, and the code is spent when the button posts it back. Only that form's POST counts: it must be form-encoded, any fetch metadata must be a same-origin page navigation, and any `Origin` must be the dashboard's own, so a script's or another site's POST does not spend a code. A chat app fetching a pasted link for its preview gets that page or a redirect, never submits it, and so leaves the code for the device you meant. A code that is used, expired or unknown redirects without setting the cookie, so the browser lands on the locked screen. A one-time link never carries the token, so the token stays out of its URL, the browser's history and the command line of the program that opens your browser. Other user accounts can usually read that command line, but a code read from it is spent the moment your browser uses it. The `?access_token=` form does put the token in the request URL, so request logs, such as a reverse proxy's, can record it. A browser without the cookie gets one screen, "This dashboard is locked to your computer", which names `clawboo open` and has the **Paste a sign-in link** box.

The box is exactly as strong as opening the link. It sends the code the way the sign-in page's button does, a form POST to `?access_code=` on the dashboard's own page, so the code is spent once, within its two minutes, for the same cookie, and the server answers with a `303` to the page without the code. The code never appears in the address bar, and the dashboard stores nothing in the browser. The box accepts only a link for the address the dashboard is open at: the same scheme, host and port, and the same `CLAWBOO_BASE_PATH`. For any other link, a link with `?access_token=`, the token itself, or text that is not a sign-in link, it says why in plain words and sends nothing. It takes only a value of the 32 characters a code always has, so the per-install token, which has 43, is never posted as a code, and neither is a token of 32 hex digits. It never opens the address you paste. When the server refuses the code, the page comes back with `?signin=pasted`, which the dashboard removes from the address at once, and the locked screen says that the link had already been used or had expired.

| Request                                    | Answer                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?access_token=` with the right token      | `302` redirect that sets the cookie                                                                                                                                                   |
| `?access_token=` with a wrong token        | `401` `{"error":"Invalid Clawboo access token."}`                                                                                                                                     |
| `?access_code=` with a live code           | `302` redirect that sets the cookie                                                                                                                                                   |
| `?access_code=` with no fetch metadata     | `200` sign-in page whose button posts the code; the code stays live until then                                                                                                        |
| The sign-in form's `POST`, live code       | `303` redirect that sets the cookie                                                                                                                                                   |
| Any other `POST` to `?access_code=`        | `303` redirect, no cookie; the code stays live                                                                                                                                        |
| `?access_code=` from a fetch or a frame    | `302` redirect, no cookie; the code stays live                                                                                                                                        |
| `?access_code=` used, expired or unknown   | `302` redirect, no cookie                                                                                                                                                             |
| An `/api/` request without a valid cookie  | `401` ``{"error":"Clawboo access token required. Run `clawboo open` on the computer running Clawboo, or open /?access_token=<token> once to set a cookie.","gate":"clawboo-access"}`` |
| `POST /api/access/launch-code` with cookie | `200` `{"gated":true,"code":"…","expiresAt":…,"expiresInMs":120000}`, or `{"gated":false}` on a server with no token                                                                  |

**One secret, full access.** Everyone who has the token can do everything you can, and so can anyone who has a live one-time link. There are no accounts, roles or per-person revocation. Behind a sign-in proxy, the [proxy identity lane](#signed-identity-from-a-sign-in-proxy) can record who each person is, but it does not limit what anyone can do. To rotate the token, change the variable, or delete `~/.clawboo/access-token`, and restart the server; every browser then signs in again.

**Agents do not receive it.** Clawboo removes `STUDIO_ACCESS_TOKEN` from the environment of the coding runtimes, Clawboo Native shell commands and connectors it starts, and the per-install token is never in any environment. The exception is an OpenClaw Gateway that you start from the dashboard: it inherits the server's whole environment, so it gets a `STUDIO_ACCESS_TOKEN` you set, but not the per-install token. A program running as you can still read the token file. Clawboo's own agents reach the MCP servers another way:

- **From the release after 0.5.0**, every MCP attach URL Clawboo writes for its agents carries an `attachToken`, derived from a per-install secret in Clawboo's database. A request without the cookie reaches the four MCP servers (`/api/mcp/tasks`, `/api/mcp/memory`, `/api/mcp/tools`, `/api/mcp/teamchat`) only when all of these hold:
  - it carries a valid attach token;
  - it connects directly from a loopback address;
  - it has none of the headers a proxy adds: `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `X-Real-IP`.

  `/api/mcp/config` always needs the cookie. A leaked attach token is useless from another machine or through your proxy, and `POST /api/mcp/attach-secret/rotate` replaces every token and signature at once (see [MCP servers](/operating/mcp-servers#the-attach-token)).

- **On 0.5.0 and older**, any request from `127.0.0.1` reaches all of `/api/mcp/` without the cookie. See the advisory at the top of this page.

**The proxy warning.** With the token turned off, the first request that carries one of those proxy headers makes the server log a one-time `SECURITY:` warning. It says that the dashboard and every `/api/` route are open to anyone who can reach the proxy. The warning never blocks a request.

**The `clawboo` command finds the token the way the server does.** It uses the `STUDIO_ACCESS_TOKEN` in its own shell when one is set, nothing when it is set blank, and otherwise reads `~/.clawboo/access-token`; it never creates the file. Its status check gets a `401` from a server that has a token, and it then asks that port once more with the token as the access cookie. It sends the token only to a port whose `401` is the access gate's own, and only to the port the server recorded in `~/.clawboo/api-port.txt`, at `127.0.0.1`. So another service in the port range, or another user's program listening on `::1` or a spare port and imitating the gate, never receives it. It never puts the token in a URL or a command line. It dials and opens `127.0.0.1` rather than `localhost` for the same reason, or the loopback address `HOST` names (`::1`, or another `127.x` address) when that is all the server listens on. That holds for a `STUDIO_ACCESS_TOKEN` you set in the shell too: `CLAWBOO_API_PORT` alone never qualifies a port, since it stays set while the server is down, when anyone could listen there. If the server cannot write `api-port.txt`, it logs a warning saying the command cannot sign in to it. A server that `clawboo` starts inherits the shell's environment, so both pick the same token. When the server's token is neither of these, `clawboo`, `clawboo stop` and `clawboo restart` report that a server is running and requires an access token, then exit. See [Token-gated installs](/reference/cli#token-gated-installs).

<Accordion title="Under the hood">

- The token and the cookie value are each hashed with SHA-256 and compared in constant time, so the check leaks neither timing nor length.
- Launch codes are 24 random bytes as base64url, held in the server's memory only, as SHA-256 digests. At most 64 unused codes are kept; minting another drops the oldest. A restart forgets them all.
- A token file that another app is still writing can read as empty for a moment, so an empty file is read again for up to half a second before the server refuses it.
- The token check and the same-origin guard read a request's path every way the server does: as sent, as the URL parser resolves it, and as the router matches it, each in lower case. A request is an `/api/` request when any of those readings is under `/api/`, and the attach-token exception for the MCP servers applies only when all of them are. The API routes also match letter case exactly, so `/API/settings` cannot slip past either check.
- The attach token is a hex HMAC-SHA256 keyed with a 32-byte secret stored in the database (`settings` key `mcp-attach-scope-secret`). It is the same in every attach URL on an install. Attach URLs that bind a team or an agent also carry a `scopeSig` signature over that scope.
- When the server's environment sets `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY`, Clawboo adds `127.0.0.1`, `localhost` and `::1` to `NO_PROXY` for the agents it starts. Their MCP calls then never pass through that proxy.
- The request log masks `attachToken`, `scopeSig` and `provSig` in every URL it records.

</Accordion>

## Signed identity from a sign-in proxy

Off by default. With a sign-in proxy in front of Clawboo, such as Cloudflare Access or oauth2-proxy, an administrator can turn on the proxy identity lane (`CLAWBOO_PROXY_IDENTITY` or the `proxyIdentity` operator file key). Clawboo then checks the signed token the proxy sends with each request and records the person it names on approvals, chat messages and task moves. [Run Clawboo behind a sign-in proxy](/guides/sso-proxy) has the setup.

- **Public keys only.** Clawboo verifies the token with the proxy's public key or its JWKS URL, and accepts only asymmetric signatures. It refuses to start with a private key or a shared HMAC key, and refuses unsigned (`alg: none`) tokens and HMAC tokens "signed" with the public key. A shared secret would not work here: agents run as your user account and could read it, then sign a token as anyone.
- **Bound and short-lived by default.** A request-bound token names the request's method and path, lives at most `proxyIdentityMaxLifetime` seconds (60 by default), and works once. Proxies that send their own sign-in token on every request need `session` binding, where a copied token works on any path until it expires.
- **Never downgraded.** A token that does not verify gets `401`, in every mode. It never passes as an unnamed request.
- **Beside the access token.** While the access token is on, a request needs the cookie too. In `required` mode, a request without a good token is refused, so an agent that reads the access token file can no longer use the API as a person. A spawned runtime's own MCP calls still work by their attach token, which opens only the four MCP mounts: never settings, budgets, holds, the board or a team's work check, however the path is spelled.
- **The person check.** A person the lane verified passes [the person check](#the-person-check) on every person write, from a script as well as from the dashboard.
- **An app that starts Clawboo.** Separately from the proxy, an app that starts Clawboo itself, such as the desktop app, can hand it an Ed25519 public key in `CLAWBOO_APP_LINK_PUBLIC_KEY` and sign its own requests for its own people, whose ids start with `account:`, which a proxy may then not name. Clawboo reads that key from the environment only, never the operator file. Such a person passes the person check like a proxy's, but only on the routes the app signs for (sending work to an agent or a team, answering an approval, checking its link), and cannot answer an approval with `allow_always`: a copied key cannot create grants, change who is asked about what, or change a setting. Whoever holds the app's private key can sign as any of its people, so the key is only as safe as the app keeps it. [An app that starts Clawboo](/guides/sso-proxy#an-app-that-starts-clawboo) has the details.

What it does not change: everyone who gets through the proxy can still do everything, since roles are recorded and not enforced (no route checks a role yet); the records live in a database that programs running as your user can change; in `on` mode the access token alone still gets in, unnamed; and an operator file this user owns, can write or can replace through a folder above it would let an agent swap the key, which the server warns about at startup (on Windows, whenever the settings come from the file, since it cannot check who can change it there). The guide lists [everything it does not protect](/guides/sso-proxy#what-it-does-not-protect).

## The person check

Some writes carry a person's authority: moving a card, Retry, Assign, answering an approval, a person's comment on a task, and setting a team's work check. Each of them goes through one check, which lets a request through when:

- a [sign-in proxy](#signed-identity-from-a-sign-in-proxy) vouched for the person who sent it, or
- the dashboard's own page sent it. A browser marks its page's requests with `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: cors` (or `same-origin`). Over plain `http` to another machine's address, see [Plain http](#plain-http-to-another-machine) below.

Any other caller, such as `curl`, a script or an agent's command, does not get the person's authority:

| Write                                      | Without the person check                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry, Assign                              | `403` `{ "ok": false, "error": "person_only" }`                                                                                                          |
| Answering an approval                      | `403` `person_only`, on `POST /api/tools/approvals/:id/resolve`, `POST /api/capabilities/approve` and `POST /api/approvals`                              |
| A team's work check                        | `403` `person_only` on `PUT /api/team-verify-command/:teamId`                                                                                            |
| Moving a card (`PATCH /api/board/:taskId`) | The move happens, as an agent's own move does: it stops no run, cannot undo a person's move, cannot use `humanOverride`, and is not recorded as a person |
| A comment                                  | Saved as an `agent` comment, whatever `authorType` it named, with no `authorAgentId`, and delivered to no run                                            |

These writes take the same check and answer the same `403`:

- Creating a task for a named agent: `POST /api/board` with `assigneeAgentId`, or with a `sourceDelegationId` that names an agent or says a person chose. Both write what Assign writes. So does `assignToMe`, which makes the task the sender's. A task with none of them does not need the check.
- Reopening a finished task, assigning a task to a person, answering a question an agent asked and answering the card about agents waking each other: see [What counts as a person](#what-counts-as-a-person).
- A team's setting that lets its agents wake each other without asking: `PUT /api/team-agent-wakes/:teamId`.
- A job's answer at its limit of runs started by itself: `POST /api/board/job-limit/:jobTaskId`.
- A team's switch for asking before a plan starts: `PUT /api/team-plan-approval/:teamId`. Accepting or turning down a plan is answering a question, above.
- A team's readable-id letters, its labels and a task's labels.
- Marking a task or the inbox read.
- Pausing and resuming an agent, a team or a task tree: `POST /api/pauses` and `DELETE /api/pauses/:kind/:id`.
- Completing a worktree: `PATCH /api/board/:taskId/workspace` with `{"action":"complete"}`, which moves the card and, on an empty diff, can pass a failing check. `pause` moves no card and stays open.
- A team's rules (`PUT /api/team-rules/:teamId`) and what you tell a team about yourself (`PATCH /api/teams/:id/onboarding`). A team's agents read both as yours on every turn. Each change goes in the audit log.
- Which agent is Boo Zero: `POST /api/boo-zero/override`, also audited.
- Archiving or restoring a team, or changing who leads it: `PATCH /api/teams/:id` when it changes `isArchived` or `leaderAgentId`. A change of lead also goes in the audit log.
- Pressing Stop: `POST /api/teams/:id/chat/stop` and `POST /api/agents/:agentId/chat/stop`.
- Budgets: `POST /api/governance/budgets` and `POST /api/governance/budgets/:scope/:scopeId/resume`.
- What decides whether anyone is asked. An agent's posture: `POST /api/exec-settings`, `POST /api/agents/:agentId/shell`. Standing grants: `POST /api/grants`, `POST /api/grants/:id/revoke`, `POST /api/grants/:id/resume`, `POST /api/exec-allowlist/revoke`, and `POST /api/system/approve-device` for a device. OpenClaw's own settings: `PATCH /api/system/openclaw-config`, `POST /api/system/configure-openclaw`, `POST /api/system/auto-configure-openclaw`. What a runtime may use: `POST /api/capabilities/enable` and `disable`.
- Who is on a team, and whether a team or a room is there at all: `POST /api/teams/:id/agents`, `DELETE /api/teams/:id/agents/:agentId`, `POST /api/agents/:agentId/move`, `DELETE /api/agents/:agentId`, `POST /api/agents/cleanup-ghosts`, `POST /api/agents/sync` with a list, `DELETE /api/teams/:id`, and `DELETE /api/teams/:id/rooms/:roomId`. Deleting a team and archiving a room go in the audit log.
- Creating an agent (`POST /api/agents`) when the body names a team or sets how it is asked: a `teamId`, any `execConfig` on OpenClaw, or `execConfig.execAsk` or `execConfig.tools.shell` elsewhere. A plain agent needs no check.
- Routines and OpenClaw's cron jobs: `POST /api/schedules`, `PATCH` and `DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`, and setting the time zone Routines run in (`PUT /api/schedules/time-zone`), since that moves every armed Routine's next run.
- A task's brief: `PATCH /api/board/:taskId` when it changes `title` or `description`. The next run follows them.

`POST /api/board/:taskId/executions` answers `409 person_moved` while a person's move stands, because a new run is what ends one. `POST /api/runtimes/:id/run` does too, and also answers `409` with the reason when the board would not start the task by itself, such as `stopped` after a Stop. With the check, it runs anyway.

The attach signature on a run's MCP URLs names the server it is for, so a Memory URL's signature cannot open the Tasks tools. A runtime can still attach with no signature at all, and get what an [unverified caller](/reference/mcp-tools#callers-and-scoping) gets.

The chat message routes stay open, without a person's authority, so a script can still talk to an agent. A message through `POST /api/teams/:id/chat` or `POST /api/agents/:agentId/chat` without the check reads `Local API call` in the chat rather than `You`, and records no one as asking. To a team, it leaves the failure breaker as it is, and the lead can still hand work out. To Boo Zero in its one-to-one chat, it starts no work, does not end the hold a Stop left, and does not read results waiting for you.

Two things a person can set are quietly limited rather than refused. A priority of Urgent stops at High without the check, on a new task and on a move. And `POST /api/board` records who asked for a task (`requested_by`) only with the check. No request body can name the person who asked or the person a task is for: the fields are not read, and the person comes from the check.

A script you run yourself can say it acts for you by sending the two `Sec-Fetch-` headers above.

### Plain http to another machine

Browsers send `Sec-Fetch-` headers only to a secure address: localhost, or `https`. A dashboard opened at, say, `http://192.168.1.20:18790` sends none, and the check would refuse its own page. So for a request over plain `http` to an address that is not loopback, and only when it carries no fetch metadata at all, an `Origin` header that names the same host and port as the `Host` header counts as the page's.

What that means in practice:

- It is no stronger than the headers it stands in for. Anything that can reach the address can send those two headers.
- It does not apply on localhost or over `https`, where a browser always sends fetch metadata, so a request without it stays refused there.
- A proxy that rewrites `Host`, as nginx does by default, makes the two disagree, so the dashboard's own writes fail the check, and the dashboard says so. Make the proxy pass the original `Host` (`proxy_set_header Host $host;`), or use `https`.

The check sits on Clawboo's REST routes. A dashboard tab with its own Gateway connection answers an OpenClaw command directly over that connection, which the access token guards and this check does not. The approval and connector-grant controls in [What agents can do](#what-agents-can-do-on-your-machine) are not changed by it.

<Warning>

On your own computer this is a speed bump, not a security boundary. Agents run as your user account, so an agent can send the same headers, read `~/.clawboo/access-token`, or change Clawboo's database directly. The check stops a confused or prompt-injected agent from passing for you by accident or by setting one field. Behind a sign-in proxy in `required` mode, every API request has to name a verified person, so an agent that holds the access token still cannot use these routes. An agent running as the same user as Clawboo can still change the database directly, for example to answer an approval. Nothing keeps it out by default. With [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) set, agents other than OpenClaw's run as their own user, which can neither read the token file nor open the database.

</Warning>

Creating, claiming, moving, linking and commenting on a task record who did it, and so do a person's Reopen, assignment, answer, pause and resume, and an agent's question and hand-back. Through the board routes, the event says `actor: { kind: 'person' }` or `{ kind: 'caller' }`; through the Tasks tools, it names the agent and its run (see [Who made a write](/reference/mcp-tools#who-made-a-write)). A wake is Clawboo acting on one of those writes, so its own events have no `actor`: the comment or move behind it says who, and the wake's row names the run that took it. An OpenClaw agent's writes name no agent: its MCP address is shared by all of its agents and carries no signature. Two kinds of write record nothing: editing a task's title, description or priority, and pausing a worktree.

If the dashboard tells you it could not tell a request came from you, a proxy is usually why. See [the troubleshooting entry](/guides/self-host-securely#troubleshooting).

## What counts as a person

Some board writes are a person's alone: answering a question an agent asked, answering the card about agents waking each other, reopening a finished task, and assigning a task to yourself. Each sits under `/api/`, never under `/api/mcp/`, so a runtime's attach token does not reach it, and no Tasks tool does any of them. Each takes [the person check](#the-person-check), so a request it does not let through gets `403` `person_only`, and records who did it: the person a sign-in proxy vouched for, else the install's built-in person, "You".

| Your install                          | What stops an agent acting as a person                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local, or behind a proxy in `on` mode | A speed bump. An agent running as your user can read the access token file and send the same fetch metadata. It stops an agent passing for you by setting one field, and no more. With [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) set, an agent other than OpenClaw's runs as its own user and cannot read the token file |
| Behind a proxy in `required` mode     | The request also needs a token the proxy signed, so reading the access token file is not enough                                                                                                                                                                                                                                   |

A dashboard opened over plain `http` on a network address passes the check through [the `Origin` fallback](#plain-http-to-another-machine), which is no stronger.

Isolating agents from your user account is what turns the local case into a boundary for them: set [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) (releases after 0.6.0; 0.6.0 ignores it). It does not cover OpenClaw agents, or other programs running as you. Without it, treat "a person answered" as the board's record of what happened, not as proof.

## Keys and secrets on disk

Clawboo encrypts the keys it stores for itself, but some copies are plain text. Paths below use the defaults; `CLAWBOO_HOME` moves `~/.clawboo` and `OPENCLAW_STATE_DIR` moves `~/.openclaw`.

| What                                                                                                                                                  | Where                                                                                         | Encrypted                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Keys you connect on a **Runtimes** card; connector credentials, sign-ins and Composio key                                                             | The vault: `~/.clawboo/secrets/runtime-keys.json`, with its key in `secrets/master.key`       | Yes                                      |
| [Website logins](/using/website-logins) and the 1Password service account token                                                                       | The vault                                                                                     | Yes                                      |
| Keys you connect under **Providers**                                                                                                                  | The vault, plus OpenClaw's `~/.openclaw/.env` and every OpenClaw agent's `auth-profiles.json` | The vault copy only                      |
| The OpenRouter, Anthropic and OpenAI keys Hermes reads (from a Runtimes card, Providers or Clawboo's environment), and each profile's own gateway key | Every Hermes agent's profile: `~/.clawboo/runtimes/hermes/_gateway/profiles/<profile>/.env`   | No (`0600`)                              |
| The Hermes gateway's key                                                                                                                              | The vault, plus `~/.clawboo/runtimes/hermes/_gateway/.env`                                    | The vault copy only (the file is `0600`) |
| A copy of your `~/.hermes/config.yaml`, which can hold a provider's `api_key`, and of your Hermes ChatGPT sign-in                                     | Each Hermes profile's `config.yaml` and `auth.json`                                           | No (`0600`)                              |
| The Gateway token and the provider key that OpenClaw setup writes                                                                                     | `~/.openclaw/.env`, and the agents' `auth-profiles.json`                                      | No                                       |
| The Gateway address and token Clawboo connects with                                                                                                   | `~/.clawboo/settings.json`                                                                    | No                                       |
| The secret that signs MCP attach URLs, and every board, chat and memory                                                                               | `~/.clawboo/clawboo.db`                                                                       | No                                       |
| The Gateway device key ([below](#the-openclaw-gateway-device-key))                                                                                    | `~/.clawboo/proxy-device-identity.json`                                                       | No                                       |

Clawboo writes the Providers copies so the OpenClaw Gateway can use the same key. **Disconnect** under **Providers** removes the vault copy and the OpenClaw copies. A key you connect on a Runtimes card stays in the vault, apart from the Hermes copies.

**Hermes keeps keys in its profiles.** Hermes's gateway reads a provider key only from an agent's profile, so Clawboo writes the keys Hermes reads into every Hermes agent's profile, before each of that agent's runs and at every gateway start, wherever the key came from (a key only in Clawboo's environment included). They stay there between runs, for the jobs Hermes runs on its own. A key you connect, replace or remove anywhere in Clawboo (the **Hermes** row, another runtime's row, or **Providers**) reaches every agent's profile right away. If a profile cannot be written then, the change reaches it before that agent's next run or at the next gateway start. A profile set aside for a deleted agent keeps the keys it had (see [Hermes](/runtimes/hermes#agent-profiles)). Your `config.yaml` is copied once, when a profile is new. With [agents as their own user](/operating/agent-isolation), these files are under `<agent home>/runtimes/hermes/_gateway` and belong to the agent user; your own `config.yaml` and sign-in are never copied there, and a profile's `auth.json` is the agent user's own Hermes sign-in.

For which runtime reads which key, and what each Disconnect removes, see [Providers and runtimes](/using/providers-and-runtimes).

**The plain-text files are owner-only.** Clawboo writes `.env`, each `auth-profiles.json` and `settings.json` readable only by you (mode `0600`), and narrows an existing file to `0600` before it writes new contents. If it cannot narrow a file that others can read (one another user owns, say), it refuses to write the key into it. When Clawboo creates `~/.clawboo` or `~/.openclaw`, it makes them owner-only (`0700`); an existing `~/.openclaw` keeps its mode. A file that 0.5.0 or older wrote keeps its mode until Clawboo writes it again. Each Hermes file above is written `0600` too. Programs running as you can still read these files, and so can every Hermes agent read every Hermes profile. Modes are best-effort on Windows.

**What the vault protects.** Each value is encrypted with AES-256-GCM. The key sits next to the ciphertext, so the encryption protects `runtime-keys.json` when that file is copied or shared on its own. Anything that can read your Clawboo folder can read the key too. A wrong or missing key never yields part of a value: saved keys read as missing, and System Health reports that the master key changed.

**Keeping the key elsewhere.** `CLAWBOO_SECRETS_MASTER_KEY` supplies the key from the environment instead of `master.key`. Move your existing key rather than creating a new one, or every saved key becomes unreadable:

<Steps>

<Step title="Stop Clawboo">

Stop the server with `clawboo stop`, Ctrl+C in its terminal, or your service manager.

</Step>

<Step title="Move the key out of the Clawboo folder">

```bash
mkdir -p ~/.config/clawboo
mv ~/.clawboo/secrets/master.key ~/.config/clawboo/master.key
chmod 600 ~/.config/clawboo/master.key
```

</Step>

<Step title="Start Clawboo with the key in its environment">

```bash
export CLAWBOO_SECRETS_MASTER_KEY="$(cat ~/.config/clawboo/master.key)"
```

Then start the server as usual, with this variable set every time. If it is missing, Clawboo creates a new key and cannot read the keys you saved before. A value that is not a 32-byte key (as base64, 64 hex characters, or 32 plain characters) makes every save fail and every saved key read as missing.

</Step>

</Steps>

This keeps a copy or backup of your Clawboo folder from carrying the key. It does not stop a program running as you, which can read both files.

**Treat the database and its backups as secrets.** `clawboo.db` holds every board, chat and memory, and the secret that signs MCP attach URLs. Anyone with a copy can sign attach URLs as any of your agents. Clawboo keeps the database and your Clawboo folder readable only by you (file modes are advisory on Windows). `clawboo backup` writes its file readable only by you (mode `0600`) from the first byte. A backup made with 0.5.0 or older has your default permissions, so restrict it with `chmod 600`. See [Data and state](/operating/data-and-state).

## What agents can do on your machine

Agents work with your user account's permissions. Claude Code and Codex run with their own sandboxes and approval prompts turned off, and Hermes asks only before the commands its own policy flags, so all three can read and change any file you can, run commands and reach the network. A task's git worktree keeps its file changes apart, but it is not a sandbox. A run without a worktree starts in the [work folder](/operating/data-and-state#the-work-folder) (`~/clawboo-work` by default): a run on a task, including research and review tasks and the tasks Routines you make in the dashboard file, in the task's own folder (`teams/<team id>/tasks/<task id>`), and every other team-chat turn and every one-to-one chat with these agents in its team's folder (`teams/<team id>`). Clawboo Native's file tools write only in the folder its run starts in, and on a task read only within the team's folder that holds it. The work folder sits outside Clawboo's data folder, so `../..` from a team folder, a task folder or a worktree does not reach the database, and neither does a tool that walks up parent folders. Work an install keeps in the data folder (see [The work folder](/operating/data-and-state#the-work-folder) for when that happens) does not get that distance. It is not a boundary: the folder only sets where the run starts, and these runtimes can still open Clawboo's database and key vault in `~/.clawboo` by their full path. Clawboo reads and writes the task files at the top of a checkout or team folder (`AGENT_HANDOFF.json`, `init.sh`, `task-progress.md`, `VERIFICATION.md`) without following a link or a hard link an agent put there: a linked file reads as missing, and a write replaces the name instead of writing through it. Clawboo Native agents run a shell command only when their **Let this Boo ask to run commands** switch is on and you approve that command. Coding runtimes and connectors do not inherit Clawboo's own secrets from the environment (an OpenClaw Gateway that Clawboo starts does), but they can read credential files on disk. Run untrusted work under a separate user account or in a virtual machine. In releases after 0.6.0, [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) is the built-in way to do the first: Claude Code, Codex, Hermes and Clawboo Native's commands and file tools then run as their own user, which cannot open the database, the vault, its key, settings or the access token. It does not limit network access, protect an agent's own credentials from it, or keep agents apart from each other, and OpenClaw agents still run as whoever started the Gateway. [What agents can do](/concepts/permissions) has the details for each runtime.

**Agents' browsers.** The Playwright and Chrome DevTools connectors drive a real Chrome on this computer, so Clawboo keeps them off the dashboard and off your files:

- Each browser starts with the dashboard's port blocked on every loopback address and on the address set in `HOST`. Chrome applies the block when it looks up an address, so a redirect, a page's script or a WebSocket cannot reach the dashboard either.
- Clawboo refuses any connector call that names the dashboard, and any `url` that would open a file on this computer, such as `~/.clawboo/access-token`.

What this leaves open:

- A name that reaches Clawboo through a reverse proxy, or one in `CLAWBOO_ALLOWED_HOSTS`, is not blocked. There the access token keeps an agent's browser out, because the browser has its own profile, without your sign-in cookie.
- If the browser sends web traffic through a proxy server, such as one set in this computer's network settings, a redirect to a network address set in `HOST` can reach the dashboard through the proxy, which looks the address up itself. Chrome keeps loopback addresses off a proxy by default, so the dashboard's own loopback addresses stay blocked. There, too, only the access token keeps an agent out.
- Other ports on this computer stay reachable, so a local web server that serves your files, or forwards to Clawboo, is open to agents' browsers.
- With Admin access, Playwright's `browser_run_code_unsafe` runs code in the Playwright server itself, outside these checks.
- A browser connector you add yourself gets none of this.

## Website logins

When an agent calls `fill_login`, Clawboo fills a saved login (or one from 1Password) into the agent's own browser, on a page whose live address is exactly the login's. The username, password, one-time code and 1Password token never reach the model, the event log, the tool audit, the server's log or a REST answer through the fill, and a run uses only its own person's logins. Clawboo masks the filled values (4 characters or longer) out of that agent's later browser tool results, but not out of screenshots. Once a password is in the page, though, the agent drives that page and can read or send what is in it, so give an agent only logins you would trust it to use. Without [`CLAWBOO_AGENT_USER`](/operating/agent-isolation), agents run as your user and a misbehaving one could read the vault and its key directly; with it, they cannot. See [Let agents sign in to websites](/using/website-logins#what-this-protects-and-what-it-does-not).

## The OpenClaw Gateway device key

When Clawboo connects to an OpenClaw Gateway, its server signs the handshake with an Ed25519 device key stored in `~/.clawboo/proxy-device-identity.json`, readable only by you. The key identifies Clawboo to the Gateway and nothing else: it plays no part in signing in to the dashboard, which is the access token's job. The Gateway token stays on the server too. The browser never receives it, and `GET /api/settings` reports only whether one is set. To connect a Gateway, see [OpenClaw](/runtimes/openclaw).

## Redaction in responses and logs

Clawboo masks credential-looking text at two points:

- **Before saving.** Tool-call records, memory facts, governance audit entries, observability events, run summaries and the verify gate's output have recognized secrets replaced with `[REDACTED]` before they are written. The command text of an OpenClaw command approval is stored as written.
- **Before showing or logging.** Observability, audit, tool-call and System Health data is masked with `••••` before it is sent to the browser. So are the structured fields of every server log line.

The masking covers values under keys that contain words such as `token`, `secret`, `password`, `auth`, `credential` or `cookie`, though token counts are kept. It also covers strings shaped like common API keys, `Bearer` headers, JWTs, private-key blocks and `NAME_KEY=value` lines.

Before saving, Clawboo also masks the exact values of the keys saved in its vault, whatever their format: provider keys (a Groq, Mistral or xAI key included), connector credentials and connector sign-in tokens. It catches them as written, inside JSON text and inside URLs. Values shorter than 12 characters are left alone, so a short password cannot wipe ordinary words out of the record. A key Clawboo never saved, such as one exported in your shell or kept only in `~/.openclaw/.env`, is masked only when it has a known format, and so is anything shown or logged without being saved first.

## Rate limits

Clawboo limits how many requests one client address can make per minute. Every `/api/` request counts toward a high general ceiling. Routes that install software, change runtime or OpenClaw setup, connect connectors or runtimes, start sign-ins, approve devices or update Clawboo have a much lower one. Over a limit, requests get `429` with a `Retry-After` header.

The limits count the connection's own address and ignore `X-Forwarded-For`, so behind a reverse proxy every visitor shares one allowance. They stop runaway clients; they are not access control. The numbers are in [Limits and defaults](/reference/limits-and-defaults).

## Reaching Clawboo from another machine

The rules in short; [Reach Clawboo from another machine](/guides/self-host-securely) has the steps.

1. **Prefer an SSH tunnel.** Clawboo keeps listening on `127.0.0.1`, and SSH does the authentication.
2. **Keep the token on behind every reverse proxy.** Never set `STUDIO_ACCESS_TOKEN` blank there unless the proxy authenticates every request itself. Setting your own `STUDIO_ACCESS_TOKEN` gives you a token you know, for signing in remotely. Also set `CLAWBOO_ALLOWED_HOSTS` and `CLAWBOO_ALLOWED_ORIGINS`, forward `Host` and `X-Forwarded-Proto`, and deny `/api/mcp/` at the proxy.
3. **For a network bind, use `HOST=0.0.0.0` with the token on**, plus the two allowlists for the address people use. Plain `http://` sends the cookie unencrypted, so put TLS in front unless you trust the network.

<Warning>

**A reverse proxy is not authentication.** nginx, Caddy and a Cloudflare Tunnel connector deliver every request from `127.0.0.1`, so to Clawboo the whole internet looks like a local caller. With the token turned off (`STUDIO_ACCESS_TOKEN=` set blank), or on 0.5.0 and older without `STUDIO_ACCESS_TOKEN`, the dashboard and every `/api/` route are open to anyone who can reach the proxy, and the server starts without complaint. Keep the token on, or make the proxy authenticate every request (HTTP basic auth, an SSO proxy such as oauth2-proxy, Cloudflare Access).

</Warning>

## Limits of this model

- **One person, one secret.** There are no user accounts, roles or per-team permissions, and the token gives full access. A sign-in proxy's identity tokens add names to what people do, not permissions.
- **A person's writes on a local install are a speed bump.** See [What counts as a person](#what-counts-as-a-person).
- **One store for the whole install.** All teams share one database and one vault, and each key name holds one value for the whole install.
- **Local code is trusted.** Anything running as your user can read Clawboo's files, the token file among them, and so use its API, the person check included. [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) (releases after 0.6.0) moves agents other than OpenClaw's out of that group.
- **Roles are not enforced.** A sign-in proxy's token can carry a role, which Clawboo records. No route refuses a person for their role yet.

## Related

- [Reach Clawboo from another machine](/guides/self-host-securely): SSH tunnels, reverse proxies and network binds, step by step
- [Run Clawboo behind a sign-in proxy](/guides/sso-proxy): signed identity tokens, and who approved what
- [What agents can do](/concepts/permissions): sandboxes, worktrees and approvals for each runtime
- [Run agents as their own user](/operating/agent-isolation): keep agents out of the database, the vault and the token
- [Providers and runtimes](/using/providers-and-runtimes): connecting keys, and what Disconnect removes
- [Data and state](/operating/data-and-state): every file Clawboo writes, backups and resets
- [Environment variables](/reference/environment-variables): `HOST`, `STUDIO_ACCESS_TOKEN`, the allowlists and the rest
- [Known issues](/appendices/known-issues): open problems, including the advisory above
