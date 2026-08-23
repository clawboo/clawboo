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

## Automated security tooling

Three automations run alongside human review. None of them replaces a report: they cover the classes of
problem a machine is good at, and the interesting bugs in a tool like this are still the ones a person finds.

- **Code scanning.** [CodeQL](https://codeql.github.com/) analyses every pull request, every push to `main`,
  and re-scans weekly, covering both the TypeScript sources and the GitHub Actions workflows themselves
  (`.github/workflows/codeql.yml`). Findings appear in the **Security** tab, the same tab you report through.
- **Dependency updates.** Dependabot opens grouped update pull requests weekly for the root pnpm workspace,
  the standalone `website/` project, and the pinned action versions (`.github/dependabot.yml`), and raises
  alerts for known advisories in anything we depend on. Alerts are triaged privately by the maintainers;
  please don't file a public issue for one.
- **Publish provenance.** Releases are published with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so a published tarball is
  cryptographically attested to have been built from this repository by the `publish.yml` workflow. Anyone
  can verify their install:

  ```bash
  npm audit signatures
  ```

  This matters more than usual for a tool installed via `npx` that then runs coding-agent runtimes on your
  machine: it lets you confirm the code you're about to execute is the code in this repository.

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

### Connectors run as you, and so does anything else on your machine

Connecting an MCP connector starts a child process under your own user account. clawboo narrows what
that child inherits: it is given an explicit allowlist of environment variables plus whatever
credentials you entered for that connector, so it never sees your provider API keys, your cloud
credentials, or clawboo's own vault key. (The MCP SDK adds a small fixed set of its own on top:
`HOME`, `PATH`, `SHELL`, `TERM`, `USER` and their Windows equivalents, none of which carry a
credential.)

Arguments are passed as an argv array, never as a shell string, so a value from the catalog or from
a path you supply cannot be interpreted as a command. On Windows a `.cmd` shim genuinely cannot be
spawned directly, so it is routed through `cmd.exe` with every token escaped individually and the
command line marked verbatim; that is a narrower thing than handing a string to a shell, but it is
not "no shell involved".

That is the environment vector, and it is the only one a local-first tool can close. **A connector
child is still a process running as you.** It can read your home directory, your SSH keys, your
`~/.aws` credentials, the clawboo database, and the vault files on disk. No local key scheme changes
that. This is why **community** entries stay blocked until a sandbox exists: installing one is a
one-click install of somebody else's package, chosen from a list rather than by you.

**Curated** entries are ones we have read and pinned to an exact version. **Custom** entries are ones
you add yourself, by typing the command or the URL. Both can be connected, and a custom entry gets no
less access than a curated one: clawboo assumes it reads private data, ingests untrusted content and
can reach the network, because it cannot know otherwise. Adding a custom connector is the same act of
trust as writing that command into any other MCP client's config, and it carries the same weight.

### Signing in to a remote connector

A remote connector authenticates with OAuth. clawboo has no registered OAuth app and ships no client
secret, so it registers itself with the provider per install (RFC 7591) and listens on an ephemeral
loopback port for the redirect. A provider that requires a pre-registered app therefore cannot be
signed into from clawboo at all, and its tile says so rather than offering the attempt.

The tokens, and the client registration itself, are stored in the same encrypted vault as connector
credentials, namespaced per connector, and are never returned by any API. **Sign out** deletes both
and stops the connection.

Two checks are what make this safe against a hostile server, and both are worth naming because
neither is obvious. Discovery must stay on the server's own origin, and the resource identifier the
server declares must be the server clawboo is talking to. Without them a compromised host could name
somebody else's authorization server, send you to a genuine consent screen for that other provider,
and receive a token minted for them. The `resource` binding alone does not prevent this, because the
value being bound is chosen by the server that receives the token.

What clawboo cannot check is what the provider does with the authorization once granted. Scopes are
requested as pinned in the catalog, or left to the provider's default where it does not accept them,
and the consent screen you approve is the provider's own.

The same reasoning applies to the governance controls. On a loopback bind with no access token, every
`/api/*` route is reachable by any process on the machine, including a connector child. Such a
process can therefore mint itself a grant, or resolve one of its own approval prompts. **Treat the
approval flow and the lethal-trifecta gate as controls against a confused or prompt-injected model,
not as controls against local code execution.** If you need the stronger property, set
`STUDIO_ACCESS_TOKEN` (see above); the token is stripped from every spawned child's environment, so a
connector cannot read it.

We do not currently run a paid bug-bounty program. We are grateful for responsible disclosure and will
credit reporters who wish to be named.
