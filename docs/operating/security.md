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
    'same-origin guard',
    'vault',
    'reverse proxy',
    'security advisory',
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

| Who could reach Clawboo                                  | Protected by default? | What protects it                                                                                                       |
| -------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Another computer on your network                         | Yes                   | Clawboo listens only on `127.0.0.1`                                                                                    |
| A web page open in your browser                          | Yes                   | The same-origin guard                                                                                                  |
| Anyone who can reach a reverse proxy in front of Clawboo | No                    | The access token, or a proxy that authenticates every request                                                          |
| Another user account on the same computer                | Partly                | Your Clawboo folder and the OpenClaw key files Clawboo writes are readable only by you; the API needs the access token |
| Agents, connectors and other programs running as you     | No                    | Nothing in Clawboo can fully stop them (see [What agents can do](#what-agents-can-do-on-your-machine))                 |

The last three rows share one cause: anything that reaches Clawboo from `127.0.0.1` looks like you. Without `STUDIO_ACCESS_TOKEN`, it can call every `/api/` route, including the ones that answer approvals, grant connector access and start agent runs.

So treat approvals and connector grants as controls against a confused or prompt-injected model, not against other code on your machine. Setting the token, even on a loopback-only install, closes the API to other user accounts. The coding runtimes and connectors Clawboo starts never receive the token, but a program running as you can still read your files, including Clawboo's database and key vault.

## The loopback bind

Clawboo listens on `127.0.0.1` unless you set `HOST`. `localhost`, `::1` and any `127.x.x.x` address also count as loopback. `HOSTNAME` is ignored, because Docker, systemd and many CI runners set it automatically; widening the bind takes an explicit `HOST`.

To listen on the network, set `HOST=0.0.0.0`. Do not bind one network address such as `HOST=192.168.1.10`. Clawboo's own agents and background jobs connect to `127.0.0.1`, and a single-address bind does not listen there, so agents lose their Clawboo tools and `clawboo` cannot find the server.

A non-loopback bind without a working access token refuses to start: the server logs `SECURITY: refusing to start` and exits with code 1. On a network, a script can send any `Host` or `Origin` header, so the same-origin guard cannot stop it and the token is the only authentication. `CLAWBOO_ALLOW_INSECURE=1` overrides the refusal and logs a `SECURITY:` warning instead. Use it only on a network where you would leave the dashboard open to everyone.

## The same-origin guard (always on)

The guard stops web pages in your own browser from using Clawboo. Your browser can reach `127.0.0.1`, so without it any site you visit could send requests to the API or open the Gateway WebSocket. The guard checks every `/api/` request and the WebSocket upgrade at `/api/gateway/ws`, with or without an access token:

- **Host** must be `localhost`, a `127.x.x.x` address, `::1`, the bind address, or a name in `CLAWBOO_ALLOWED_HOSTS`. This applies to every request, browser or not. It also blocks DNS rebinding, where an attacker's domain is pointed at `127.0.0.1`.
- **Origin**, when the request has one, must exactly match an allowed origin. Those are `localhost`, `127.0.0.1` and `[::1]` at Clawboo's port (over `http` or `https`), the bind address at that port, and the entries in `CLAWBOO_ALLOWED_ORIGINS`.
- **Sec-Fetch-Site**, when present, must be `same-origin`, `same-site` or `none`.

A rejected request gets `403` with `{"error":"Cross-origin request blocked."}`, and a rejected WebSocket upgrade gets `403 Forbidden`. The dashboard page and its static files are not checked, because they hold no data.

The two variables take comma-separated lists and only add entries; the loopback entries always stay. When you reach Clawboo by any other name or address, set both: `CLAWBOO_ALLOWED_HOSTS` for the name (`dash.example.com`) and `CLAWBOO_ALLOWED_ORIGINS` for the full origin (`https://dash.example.com`). Without them the dashboard page loads, but every API call fails with the 403 above.

In dev mode (`pnpm dev`), the server also answers CORS requests, with credentials, for the allowed origins only. In dev those include the Vite dev server on port 5173.

The guard is not authentication. A script or `curl` can send any `Host` and `Origin` it likes, which is why a network bind needs the access token.

## The access token

`STUDIO_ACCESS_TOKEN` is an optional shared secret. Clawboo reads it from the environment when the server starts; a `studioAccessToken` entry in `settings.json` has no effect. When the token is set, every `/api/` path (in any letter case) and the Gateway WebSocket need the `clawboo_access` cookie. The dashboard page and static files load without it.

<Warning>

**Use only letters, digits, `.`, `_`, `~` and `-` in the token.** With any other character the server refuses to start, on every bind: it logs `SECURITY: refusing to start`, names the character and the allowed set, and exits with code 1. `CLAWBOO_ALLOW_INSECURE=1` does not skip this, because it allows running with no token, not with one the check cannot use. Output from `openssl rand -base64` can contain `+`, `/` or `=`. Generate tokens with `openssl rand -hex 24` and save the value. On 0.5.0 and older, such a token turns the check off and the server keeps running, so behind a reverse proxy on the same machine the dashboard is open.

</Warning>

**Sign in once per browser.** Open any Clawboo address with `?access_token=<token>` added, such as `https://dash.example.com/?access_token=<token>`. Clawboo checks the token, sets the cookie and redirects to the same address without the token. The cookie is `HttpOnly` and `SameSite=Lax`, its path is `/` (or your `CLAWBOO_BASE_PATH`), and it is `Secure` when the request carries `X-Forwarded-Proto: https`. The WebSocket accepts only the cookie.

| Request                                   | Answer                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `?access_token=` with the right token     | `302` redirect that sets the cookie                                                                  |
| `?access_token=` with a wrong token       | `401` `{"error":"Invalid Clawboo access token."}`                                                    |
| An `/api/` request without a valid cookie | `401` `{"error":"Clawboo access token required. Open /?access_token=<token> once to set a cookie."}` |

**One secret, full access.** Everyone who has the token can do everything you can. There are no accounts, roles or per-person revocation. To rotate the token, change the variable and restart the server; every browser then signs in again.

**Agents do not receive it.** Clawboo removes the token from the environment of the coding runtimes, Clawboo Native shell commands and connectors it starts. The exception is an OpenClaw Gateway that you start from the dashboard: it inherits the server's whole environment, token included. Clawboo's own agents reach the MCP servers another way:

- **From the release after 0.5.0**, every MCP attach URL Clawboo writes for its agents carries an `attachToken`, derived from a per-install secret in Clawboo's database. A request without the cookie reaches the four MCP servers (`/api/mcp/tasks`, `/api/mcp/memory`, `/api/mcp/tools`, `/api/mcp/teamchat`) only when all of these hold:
  - it carries a valid attach token;
  - it connects directly from a loopback address;
  - it has none of the headers a proxy adds: `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `X-Real-IP`.

  `/api/mcp/config` always needs the cookie. A leaked attach token is useless from another machine or through your proxy, and `POST /api/mcp/attach-secret/rotate` replaces every token and signature at once (see [MCP servers](/operating/mcp-servers#the-attach-token)).

- **On 0.5.0 and older**, any request from `127.0.0.1` reaches all of `/api/mcp/` without the cookie. See the advisory at the top of this page.

**The proxy warning.** With no token set, the first request that carries one of those proxy headers makes the server log a one-time `SECURITY:` warning. It says that the dashboard and every `/api/` route are open to anyone who can reach the proxy. The warning never blocks a request.

**The `clawboo` command cannot manage a server that has a token.** Its status check gets a `401`, so `clawboo`, `clawboo stop` and `clawboo restart` report that a server is running and requires an access token, then exit. Run with the token in its environment and no server running, `clawboo` starts one but cannot see it answer: after about 45 seconds it prints `Dashboard is taking too long to start.` and exits, while the server keeps running. Start and stop a token-protected server directly or with a service manager, as described in [Run the Clawboo server](/operating/deployment).

<Accordion title="Under the hood">

- The token and the cookie value are each hashed with SHA-256 and compared in constant time, so the check leaks neither timing nor length.
- The token check lowercases the path before it tests for `/api/`, and the API routes match letter case exactly, so `/API/settings` cannot slip past it.
- The attach token is a hex HMAC-SHA256 keyed with a 32-byte secret stored in the database (`settings` key `mcp-attach-scope-secret`). It is the same in every attach URL on an install. Attach URLs that bind a team or an agent also carry a `scopeSig` signature over that scope.
- When the server's environment sets `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY`, Clawboo adds `127.0.0.1`, `localhost` and `::1` to `NO_PROXY` for the agents it starts. Their MCP calls then never pass through that proxy.
- The request log masks `attachToken`, `scopeSig` and `provSig` in every URL it records.

</Accordion>

## Keys and secrets on disk

Clawboo encrypts the keys it stores for itself, but some copies are plain text. Paths below use the defaults; `CLAWBOO_HOME` moves `~/.clawboo` and `OPENCLAW_STATE_DIR` moves `~/.openclaw`.

| What                                                                                      | Where                                                                                         | Encrypted           |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| Keys you connect on a **Runtimes** card; connector credentials, sign-ins and Composio key | The vault: `~/.clawboo/secrets/runtime-keys.json`, with its key in `secrets/master.key`       | Yes                 |
| Keys you connect under **Providers**                                                      | The vault, plus OpenClaw's `~/.openclaw/.env` and every OpenClaw agent's `auth-profiles.json` | The vault copy only |
| The Gateway token and the provider key that OpenClaw setup writes                         | `~/.openclaw/.env`, and the agents' `auth-profiles.json`                                      | No                  |
| The Gateway address and token Clawboo connects with                                       | `~/.clawboo/settings.json`                                                                    | No                  |
| The secret that signs MCP attach URLs, and every board, chat and memory                   | `~/.clawboo/clawboo.db`                                                                       | No                  |
| The Gateway device key ([below](#the-openclaw-gateway-device-key))                        | `~/.clawboo/proxy-device-identity.json`                                                       | No                  |

Clawboo writes the Providers copies so the OpenClaw Gateway can use the same key. **Disconnect** under **Providers** removes the vault copy and the OpenClaw copies. A key you connect on a Runtimes card stays in the vault. For which runtime reads which key, and what each Disconnect removes, see [Providers and runtimes](/using/providers-and-runtimes).

**The plain-text files are owner-only.** Clawboo writes `.env`, each `auth-profiles.json` and `settings.json` readable only by you (mode `0600`), and narrows an existing file to `0600` before it writes new contents. If it cannot narrow a file that others can read (one another user owns, say), it refuses to write the key into it. When Clawboo creates `~/.clawboo` or `~/.openclaw`, it makes them owner-only (`0700`); an existing `~/.openclaw` keeps its mode. A file that 0.5.0 or older wrote keeps its mode until Clawboo writes it again. Programs running as you can still read these files. Modes are best-effort on Windows.

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

Agents work with your user account's permissions. Claude Code, Codex and Hermes run with their own sandboxes and approval prompts turned off, so they can read and change any file you can, run commands and reach the network. A task's git worktree keeps its file changes apart, but it is not a sandbox. A run without a worktree starts in its team's folder (`~/.clawboo/workspaces/<team id>`). That covers every team-chat turn, every one-to-one chat with these agents, research and review tasks, and every Routine you make in the dashboard. The folder only sets where the run starts: from there these runtimes can still reach Clawboo's database and key vault. Clawboo Native agents run a shell command only when their **Let this Boo ask to run commands** switch is on and you approve that command. Coding runtimes and connectors do not inherit Clawboo's own secrets from the environment (an OpenClaw Gateway that Clawboo starts does), but they can read credential files on disk. Run untrusted work under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) has the details for each runtime.

## The OpenClaw Gateway device key

When Clawboo connects to an OpenClaw Gateway, its server signs the handshake with an Ed25519 device key stored in `~/.clawboo/proxy-device-identity.json`, readable only by you. The key identifies Clawboo to the Gateway and nothing else: it plays no part in signing in to the dashboard, which is the access token's job. The Gateway token stays on the server too. The browser never receives it, and `GET /api/settings` reports only whether one is set. To connect a Gateway, see [OpenClaw](/runtimes/openclaw).

## Redaction in responses and logs

Clawboo masks credential-looking text at two points:

- **Before saving.** Tool-call records, memory facts, governance audit entries and observability events have recognized secrets replaced with `[REDACTED]` before they are written. The command text of an OpenClaw command approval is stored as written.
- **Before showing or logging.** Observability, audit, tool-call and System Health data is masked with `••••` before it is sent to the browser. So are the structured fields of every server log line.

The masking covers values under keys that contain words such as `token`, `secret`, `password`, `auth`, `credential` or `cookie`, though token counts are kept. It also covers strings shaped like common API keys, `Bearer` headers, JWTs, private-key blocks and `NAME_KEY=value` lines. It is a safety net built on known formats, so a key in a new format can slip through.

## Rate limits

Clawboo limits how many requests one client address can make per minute. Every `/api/` request counts toward a high general ceiling. Routes that install software, change runtime or OpenClaw setup, connect connectors or runtimes, start sign-ins, approve devices or update Clawboo have a much lower one. Over a limit, requests get `429` with a `Retry-After` header.

The limits count the connection's own address and ignore `X-Forwarded-For`, so behind a reverse proxy every visitor shares one allowance. They stop runaway clients; they are not access control. The numbers are in [Limits and defaults](/reference/limits-and-defaults).

## Reaching Clawboo from another machine

The rules in short; [Reach Clawboo from another machine](/guides/self-host-securely) has the steps.

1. **Prefer an SSH tunnel.** Clawboo keeps listening on `127.0.0.1`, and SSH does the authentication.
2. **Put the token behind every reverse proxy.** Set `STUDIO_ACCESS_TOKEN` unless the proxy authenticates every request itself. Also set `CLAWBOO_ALLOWED_HOSTS` and `CLAWBOO_ALLOWED_ORIGINS`, forward `Host` and `X-Forwarded-Proto`, and deny `/api/mcp/` at the proxy.
3. **For a network bind, use `HOST=0.0.0.0` with a token**, plus the two allowlists for the address people use. Plain `http://` sends the cookie unencrypted, so put TLS in front unless you trust the network.

<Warning>

**A reverse proxy is not authentication.** nginx, Caddy and a Cloudflare Tunnel connector deliver every request from `127.0.0.1`, so to Clawboo the whole internet looks like a local caller. Without `STUDIO_ACCESS_TOKEN`, the dashboard and every `/api/` route are open to anyone who can reach the proxy, and the server starts without complaint. Set the token, or make the proxy authenticate every request (HTTP basic auth, an SSO proxy such as oauth2-proxy, Cloudflare Access).

</Warning>

## Limits of this model

- **One person, one secret.** There are no user accounts, roles or per-team permissions, and the token gives full access.
- **One store for the whole install.** All teams share one database and one vault, and each key name holds one value for the whole install.
- **Local code is trusted.** Anything running as your user can read Clawboo's files and, without the token, use its API.

## Related

- [Reach Clawboo from another machine](/guides/self-host-securely): SSH tunnels, reverse proxies and network binds, step by step
- [What agents can do](/concepts/permissions): sandboxes, worktrees and approvals for each runtime
- [Providers and runtimes](/using/providers-and-runtimes): connecting keys, and what Disconnect removes
- [Data and state](/operating/data-and-state): every file Clawboo writes, backups and resets
- [Environment variables](/reference/environment-variables): `HOST`, `STUDIO_ACCESS_TOKEN`, the allowlists and the rest
- [Known issues](/appendices/known-issues): open problems, including the advisory above
