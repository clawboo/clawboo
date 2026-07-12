# Security Policy

## Supported versions

Clawboo is pre-1.0 and ships from `main`. Security fixes land in the latest published `clawboo` release on
npm; please run the latest version before reporting.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue or discussion.

Use GitHub's [Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the repository's **Security** tab and choose **Report a vulnerability**. This routes the report
privately to the maintainers and lets us coordinate a fix and disclosure with you.

Please include: the affected version, a description, and a minimal reproduction or proof of concept.

## Scope notes

Clawboo is a **local-first** tool: by default the dashboard binds to loopback (`127.0.0.1`) so it is not
reachable from other hosts on your network, all state lives under `~/.clawboo/`, and runtime API keys are
stored in an AES-256-GCM encrypted vault. The threat model that the codebase defends against includes
malicious agent/model output, untrusted capability/skill content, untrusted peer-chat posts, a single
compromised runtime attempting to read another's state, and a browser-based drive-by attacker: a malicious
web page you visit while Clawboo is running that tries to reach the loopback API from your own browser (a
cross-site `fetch`/`no-cors` POST, or a Cross-Site WebSocket Hijack, against `http://127.0.0.1:<port>/api/*`).
Reports that match this model are especially valuable.

**Loopback is not the whole story.** A loopback bind stops other hosts on your network, but it does not stop
code running in your own browser, because your browser originates the connection to `127.0.0.1`. Clawboo
closes this with an always-on same-origin guard that validates the `Origin`, `Host` (the DNS-rebinding
defense), and `Sec-Fetch-Site` headers on every `/api/*` request and WebSocket upgrade. The guard runs
independently of the access token, so the default `npx clawboo` install is protected against the drive-by,
CSWSH, and DNS-rebinding attacker with zero configuration; a foreign origin is answered with a 403. Reaching
the dashboard from a LAN or remote browser origin requires enumerating it via `CLAWBOO_ALLOWED_ORIGINS` (and
hostnames via `CLAWBOO_ALLOWED_HOSTS`); the loopback allowlist is always enforced and env vars only widen it.

**Spawned runtimes run with a scrubbed environment.** The runtime subprocesses (Codex, Hermes, the Claude
Agent SDK child) and the verify gate never inherit Clawboo's own server secrets, nor a curated set of the
operator's third-party shell credentials (cloud, CI, package-registry, and database tokens such as
`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `DATABASE_URL`). This is best-effort by name, not a
sandbox: an un-sandboxed agent can still read on-disk credentials, so treat the tasks you run as code you are
choosing to execute locally.

### Exposing the dashboard beyond loopback

If you deliberately widen the bind (set `HOST=0.0.0.0` or a LAN address, e.g. to reach the dashboard from
another machine), the API is then reachable by other hosts on that network. In that case you **must set an
access token**: export `STUDIO_ACCESS_TOKEN=<a long random string>` before starting the server. With a token
set, every `/api/*` route and the gateway WebSocket require it (open `/?access_token=<token>` once to set the
cookie). The server **refuses to start** on a non-loopback bind with no token — set `STUDIO_ACCESS_TOKEN`, or
set `CLAWBOO_ALLOW_INSECURE=1` to run unauthenticated on purpose. (`HOSTNAME` is ignored as a bind signal, so
a container's auto-set hostname never silently widens the bind — use an explicit `HOST=`.)

We do not currently run a paid bug-bounty program. We are grateful for responsible disclosure and will
credit reporters who wish to be named.
