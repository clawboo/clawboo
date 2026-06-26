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
malicious agent/model output, untrusted capability/skill content, untrusted peer-chat posts, and a single
compromised runtime attempting to read another's state. Reports that match this model are especially valuable.

### Exposing the dashboard beyond loopback

If you deliberately widen the bind (set `HOST=0.0.0.0` or a LAN address, e.g. to reach the dashboard from
another machine), the API is then reachable by other hosts on that network. In that case **set an access
token**: export `STUDIO_ACCESS_TOKEN=<a long random string>` before starting the server. With a token set,
every `/api/*` route and the gateway WebSocket require it (open `/?access_token=<token>` once to set the
cookie). The server logs a loud warning at boot if it detects a non-loopback bind with no token configured.

We do not currently run a paid bug-bounty program. We are grateful for responsible disclosure and will
credit reporters who wish to be named.
