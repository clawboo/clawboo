---
title: 'Reach Clawboo from another machine'
sidebarTitle: 'Remote access'
description: 'Open your Clawboo dashboard from another computer through an SSH tunnel, a reverse proxy with an access token, or a network bind.'
keywords:
  [
    'self-host',
    'self-host securely',
    'remote access',
    'reverse proxy',
    'nginx',
    'Caddy',
    'Cloudflare Tunnel',
    'SSH tunnel',
    'STUDIO_ACCESS_TOKEN',
    'HOST',
    'CLAWBOO_BASE_PATH',
    'path prefix',
  ]
---

Clawboo listens only on the computer it runs on. Use this guide to open the dashboard from somewhere else: your laptop reaching a home server or a VPS, or another computer on your network. Each path below keeps the dashboard private to you. For why each step matters, see the [Security model](/operating/security).

<Warning>

**Security advisory: clawboo 0.5.0 and older behind a reverse proxy.** On these releases the access token does not cover `/api/mcp/`. Any request that reaches Clawboo from `127.0.0.1` skips the access cookie on every `/api/mcp/` path, including `/api/mcp/config`. A reverse proxy on the same machine delivers every request from `127.0.0.1`. So anyone who can reach your proxy can use Clawboo's MCP servers and ask `/api/mcp/config` for an attach URL signed as any of your agents, with that agent's connector grants. This holds even with `STUDIO_ACCESS_TOKEN` set.

If you already run Clawboo behind nginx, Caddy or a Cloudflare Tunnel, add the rule below for your proxy now, or upgrade once a release newer than 0.5.0 is out. Run `clawboo --version` to see your version.

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

The rules ignore letter case, because 0.5.0 also routes variants such as `/API/MCP/config`. Under a path prefix, add the same rule for the prefixed path (`/clawboo/api/mcp`), because Clawboo also answers `/api/` without the prefix. Releases after 0.5.0 require the access cookie on these paths. The four MCP server paths also accept an agent's attach token, but `/api/mcp/config` never does, and an attach token that arrives through a proxy is refused. The proxy recipes below keep the rule as a second layer.

## Choose a path

| Path                     | Best for                                                     | What you set up                                                                    |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| SSH tunnel (recommended) | You, from any computer that can SSH to the server            | Nothing on the Clawboo side                                                        |
| Reverse proxy            | A web address with HTTPS, such as `https://dash.example.com` | An access token, two allowlist variables, and a proxy rule that blocks `/api/mcp/` |
| Network bind             | Another computer on a network you trust, or a container      | `HOST=0.0.0.0`, an access token, and the two allowlist variables                   |

Clawboo has no user accounts. Anyone who has the access token can do everything you can, so keep it to yourself.

## Before you begin

- Clawboo is installed on the server with `npm install -g clawboo` ([Install Clawboo](/getting-started/installation)).
- You know the server's Clawboo port. While Clawboo runs, `cat ~/.clawboo/api-port.txt` prints it; it is usually `18790`.
- You know your version: run `clawboo --version`. On 0.5.0 or older, read the advisory above first.

## Option 1: SSH tunnel (recommended)

The tunnel forwards a port on your computer to Clawboo's port on the server. Clawboo keeps listening only on the server itself, and SSH does the authentication.

<Steps>

<Step title="Start Clawboo on the server">

Run `clawboo` on the server as usual, with `HOST` unset. On a server without a desktop the browser does not open; that is fine.

</Step>

<Step title="Open the tunnel from your computer">

```bash
ssh -N -L 18790:127.0.0.1:18790 you@your-server
```

Use the server's Clawboo port on both sides. With a different local port, your browser's address no longer matches Clawboo's port, and Clawboo blocks the dashboard's requests (unless you add `http://localhost:<local-port>` to `CLAWBOO_ALLOWED_ORIGINS`).

</Step>

<Step title="Open the dashboard">

Open `http://localhost:18790` on your computer. You should see your dashboard. The tunnel stays open until you stop the `ssh` command.

</Step>

</Steps>

The tunnel needs no access token, but anyone else who can log in to the server can reach Clawboo's port too. On a server other people use, also create an access token as in Option 2 and start the server directly with it.

## Option 2: Reverse proxy

A reverse proxy such as nginx, Caddy or a Cloudflare Tunnel gives Clawboo a web address with HTTPS. The proxy runs on the same machine, and Clawboo keeps listening only on `127.0.0.1`.

<Steps>

<Step title="Create an access token and save it">

```bash
openssl rand -hex 24
```

This prints a 48-character token. Save it in your password manager now: you need it to sign in, and the server must start with the same value every time. If you write your own token, use only letters, digits, `.`, `_`, `~` and `-`. With any other character the server refuses to start.

</Step>

<Step title="Start Clawboo with the token and your address">

Replace the token and `dash.example.com` with your own:

```bash
export STUDIO_ACCESS_TOKEN='paste-your-token-here'
export CLAWBOO_ALLOWED_HOSTS=dash.example.com
export CLAWBOO_ALLOWED_ORIGINS=https://dash.example.com
export CLAWBOO_API_PORT=18790
mkdir -p ~/.clawboo
cd ~/.clawboo
NODE_ENV=production node "$(npm root -g)/clawboo/dist/server.js"
```

Leave `HOST` unset, because the proxy connects to `127.0.0.1`. `CLAWBOO_API_PORT` pins the port the proxy forwards to. The two allowlist variables let requests that use your address pass Clawboo's same-origin guard. Without them the dashboard page loads, but every API call fails with `403 Cross-origin request blocked.`

Start the server directly like this rather than with `clawboo`, which cannot manage a server that has a token. You should see a log line saying Clawboo is ready. To keep it running after you log out, [run it as a service](/operating/deployment#run-it-as-a-service).

</Step>

<Step title="Point the proxy at Clawboo">

<Tabs>

<Tab title="nginx">

```nginx
server {
    listen 443 ssl;
    server_name dash.example.com;
    # Add your ssl_certificate and ssl_certificate_key lines here.

    # Clawboo's MCP endpoints are for agents on this machine only.
    location ~* ^/api/mcp(/|$) {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:18790;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The Gateway WebSocket at /api/gateway/ws
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # Live updates stream, and some requests stay open for a long time.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

</Tab>

<Tab title="Caddy">

```caddyfile
dash.example.com {
	@mcp path /api/mcp /api/mcp/*
	respond @mcp 404
	reverse_proxy 127.0.0.1:18790
}
```

Caddy gets the certificate, passes `Host` through, sets `X-Forwarded-Proto` and proxies WebSockets without extra settings.

</Tab>

<Tab title="Cloudflare Tunnel">

```yaml
# ~/.cloudflared/config.yml, below your tunnel and credentials-file lines.
ingress:
  - hostname: dash.example.com
    path: '(?i)^/api/mcp(/|$)'
    service: http_status:404
  - hostname: dash.example.com
    service: http://127.0.0.1:18790
  - service: http_status:404
```

The tunnel checks rules from first to last, so the deny rule must come before the Clawboo rule. Leave `httpHostHeader` unset so Clawboo sees the hostname visitors use.

</Tab>

</Tabs>

Whatever the proxy, it must pass the `Host` your browser used and `X-Forwarded-Proto`. Clawboo checks `Host` against the allowlist, builds the redirect after sign-in from both, and marks the cookie `Secure` when `X-Forwarded-Proto` is `https`.

</Step>

<Step title="Sign in once">

Open `https://dash.example.com/?access_token=<your-token>`. Clawboo sets a cookie and removes the token from the address bar, and you should see your dashboard. Each browser signs in once. The token appears in that first request's URL, so a proxy access log can record it; keep such logs private.

</Step>

</Steps>

<Warning>

**A reverse proxy is not authentication.** The proxy delivers every request from `127.0.0.1`, so to Clawboo the whole internet looks like a local caller. Without `STUDIO_ACCESS_TOKEN`, the dashboard and every `/api/` route are open to anyone who can reach the proxy, and the server starts without complaint. Keep the token unless the proxy authenticates every request itself (HTTP basic auth, an SSO proxy such as oauth2-proxy, Cloudflare Access).

</Warning>

If your proxy does authenticate every request and you leave the token out, Clawboo logs a one-time `SECURITY:` warning on the first proxied request. That is expected. If the proxy runs on a different machine, Clawboo must listen on the network. Use the bind and token from Option 3, point the proxy at the server's address, and keep the allowlists set to your public name.

## Option 3: Network bind

A network bind makes Clawboo listen on every interface of the machine, so other computers on the network can open it directly. Use it on a network you trust, or for a container whose port you publish.

<Steps>

<Step title="Create an access token and save it">

Run `openssl rand -hex 24` and save the token, as in Option 2. Clawboo refuses to start on a network bind without a working token.

</Step>

<Step title="Start Clawboo on all interfaces">

Replace the token and `192.168.1.10` with the server's address on your network:

```bash
export HOST=0.0.0.0
export STUDIO_ACCESS_TOKEN='paste-your-token-here'
export CLAWBOO_ALLOWED_HOSTS=192.168.1.10
export CLAWBOO_ALLOWED_ORIGINS=http://192.168.1.10:18790
export CLAWBOO_API_PORT=18790
mkdir -p ~/.clawboo
cd ~/.clawboo
NODE_ENV=production node "$(npm root -g)/clawboo/dist/server.js"
```

Use `HOST=0.0.0.0`, not the server's own address. Clawboo's agents and background jobs connect to `127.0.0.1`, and a bind to one address does not listen there, so agents would lose their Clawboo tools. In a container, `HOST=0.0.0.0` is also what lets the published port reach the server.

</Step>

<Step title="Sign in once">

On the other computer, open `http://192.168.1.10:18790/?access_token=<your-token>`. You should see your dashboard.

</Step>

</Steps>

Plain `http://` sends the cookie unencrypted, so anyone who can watch the network can copy it and use the dashboard. For anything beyond a network you trust, put a TLS proxy in front (Option 2).

## Serve Clawboo under a path prefix

To share one hostname with other apps, serve Clawboo under a prefix such as `/clawboo`. Add `CLAWBOO_BASE_PATH` to the variables from Option 2; the allowlists name the shared host:

```bash
export CLAWBOO_BASE_PATH=/clawboo
export CLAWBOO_ALLOWED_HOSTS=apps.example.com
export CLAWBOO_ALLOWED_ORIGINS=https://apps.example.com
```

The proxy must pass the prefix through unchanged. In nginx, that means a `proxy_pass` with no path after the port:

```nginx
location ~* ^/clawboo/api/mcp(/|$) {
    return 404;
}

location /clawboo/ {
    # No trailing slash: nginx then forwards /clawboo/... as it arrived.
    proxy_pass http://127.0.0.1:18790;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 1h;
}

# Send the bare prefix to its trailing-slash form.
location = /clawboo {
    return 308 /clawboo/;
}
```

With a trailing slash after the port, nginx strips the prefix, Clawboo redirects the page back to the prefix, and the browser loops until it gives up. Sign in at `https://apps.example.com/clawboo/?access_token=<your-token>`.

Under a prefix, the dashboard, the API, the live streams and the Gateway WebSocket all live below it, and the prebuilt package needs no rebuild. The access cookie's path is the prefix, so other apps on the same host never receive it. The value may use only letters, digits, `.`, `_`, `~` and `-` between slashes, and its first part must not be `api`. An invalid value stops the server at startup with `SECURITY/CONFIG: CLAWBOO_BASE_PATH is invalid`.

## Check that it worked

From another computer, run these with your own address in place of `dash.example.com`:

```bash
curl -i https://dash.example.com/api/settings
curl -i https://dash.example.com/api/mcp/config
curl -i https://dash.example.com/api/mcp/tasks
```

- **`/api/settings`** should answer `401`: Clawboo is reachable and wants the token. A `403` means `CLAWBOO_ALLOWED_HOSTS` does not include the name you used. A `200` means a request with no credentials got through, so anyone who can reach this address can use Clawboo: set `STUDIO_ACCESS_TOKEN`.
- **The two `/api/mcp/` addresses** should answer `404` from your proxy. A `401` means Clawboo refused them but your deny rule is missing. A `200` or `400` means they reached Clawboo's MCP endpoints: add the deny rule now.

Then sign in with your browser, open the board and send a message in a team chat. If both work, the allowlists are right.

## Settings at a glance

| Variable                   | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `STUDIO_ACCESS_TOKEN`      | The access token for the dashboard and API                                                  |
| `HOST`                     | The interface Clawboo listens on: `127.0.0.1` by default, `0.0.0.0` for a network bind      |
| `CLAWBOO_ALLOWED_HOSTS`    | Host names or addresses people use to reach Clawboo, comma-separated                        |
| `CLAWBOO_ALLOWED_ORIGINS`  | Full origins such as `https://dash.example.com`, comma-separated                            |
| `CLAWBOO_API_PORT`         | A fixed port; the server stops with an error if it is taken                                 |
| `CLAWBOO_BASE_PATH`        | A path prefix such as `/clawboo`                                                            |
| `CLAWBOO_ALLOW_INSECURE=1` | Lets a network bind start without a token, which leaves every API route open to the network |

[Environment variables](/reference/environment-variables) lists every setting.

## Troubleshooting

<AccordionGroup>

<Accordion title="Every action fails with 403 Cross-origin request blocked.">

Clawboo's same-origin guard does not recognize the name or origin in the request. Set `CLAWBOO_ALLOWED_HOSTS` to the host name and `CLAWBOO_ALLOWED_ORIGINS` to the full origin (scheme, host, and the port if it is not the default), then restart. Through an SSH tunnel, use the same port on both ends.

</Accordion>

<Accordion title="401: Clawboo access token required">

This browser has no cookie yet, or the token changed. Open your Clawboo address with `?access_token=<your-token>` once.

</Accordion>

<Accordion title="401: Invalid Clawboo access token.">

The token in the URL does not match the `STUDIO_ACCESS_TOKEN` the server started with. Check for missing or extra characters.

</Accordion>

<Accordion title="After signing in, the browser goes to an http address or to 127.0.0.1">

Clawboo builds the redirect from the `Host` and `X-Forwarded-Proto` it receives. Make the proxy pass both; in nginx, `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-Proto $scheme;`.

</Accordion>

<Accordion title="The boot log says STUDIO_ACCESS_TOKEN contains an unsupported character">

The token has a character other than letters, digits, `.`, `_`, `~` and `-`, so the server stopped rather than run without the token check. Make a new token with `openssl rand -hex 24`, start the server with it, and sign in again.

</Accordion>

<Accordion title="The log says a request reached this server through a reverse proxy">

The server has no access token, so the dashboard and every `/api/` route are open to anyone who can reach the proxy. Set `STUDIO_ACCESS_TOKEN` and restart, unless the proxy authenticates every request. The warning appears once per server start and never blocks a request.

</Accordion>

<Accordion title="clawboo says a server is running but requires an access token">

That is expected on a token-protected install: `clawboo`, `clawboo stop` and `clawboo restart` cannot use its API. Stop the server with Ctrl+C in its terminal, with your service manager, or with the command `clawboo stop` prints.

</Accordion>

<Accordion title="The server exits with SECURITY: refusing to start">

`HOST` is a network address and the server has no access token. Set `STUDIO_ACCESS_TOKEN` (letters, digits, `.`, `_`, `~` and `-` only), or unset `HOST` to listen on `127.0.0.1` again. If the message names an unsupported character in `STUDIO_ACCESS_TOKEN`, see the entry above.

</Accordion>

<Accordion title="Agents lost their Clawboo tools after setting HOST">

`HOST` names a single address, so Clawboo no longer listens on `127.0.0.1`, where its agents connect. Use `HOST=0.0.0.0` instead.

</Accordion>

<Accordion title="Live updates stop, or long requests are cut off, behind nginx">

By default nginx buffers responses and closes a connection after 60 seconds without data. Add `proxy_buffering off;` and a longer `proxy_read_timeout`, as in the recipe above.

</Accordion>

<Accordion title="MCP attach config shows Could not load attach config.">

That section, on the OpenClaw row under **Settings** then **Runtimes**, reads `/api/mcp/config`, which your proxy now denies. That is expected. Open the dashboard through an SSH tunnel when you need it.

</Accordion>

<Accordion title="An agent on another computer cannot attach to the MCP servers">

The proxy rule blocks it, and releases after 0.5.0 also refuse an attach token that arrives through a proxy. Give that computer an SSH tunnel to the server's Clawboo port instead; see [MCP servers](/operating/mcp-servers).

</Accordion>

</AccordionGroup>

## Limits

- **One token, full access.** There are no accounts or roles. To rotate the token, change the variable, restart the server and sign in again in every browser.
- **One rate-limit allowance behind a proxy.** Clawboo counts requests by the connection's address, so every browser behind the proxy shares one allowance. See [Limits and defaults](/reference/limits-and-defaults).

## Next steps

- [Security model](/operating/security): what each protection covers, and where your keys are stored
- [Run the Clawboo server](/operating/deployment): run it as a service, update it and read its logs
- [MCP servers](/operating/mcp-servers): attach agents from other tools to Clawboo
- [Data and state](/operating/data-and-state): back up and move your Clawboo folder
- [Environment variables](/reference/environment-variables): every setting the server reads
