---
'clawboo': minor
---

Run Clawboo behind an SSO reverse proxy that signs identity tokens and see who approved what.

**Off by default, set by an administrator only.** Set `CLAWBOO_PROXY_IDENTITY` (or `proxyIdentity` in the operator settings file) to `on` or `required`, with the proxy's public key or JWKS URL, its issuer and its audience. The dashboard has no switch for it. Clawboo holds only public keys: it refuses to start with a private key or a shared HMAC key, and accepts only asymmetric signatures, because agents run as Clawboo's own user and could read a shared secret.

**Each request can name the person who sent it.** The proxy adds a signed token (a JWT) to each request. By default the token is bound to the request's method and path, lives at most 60 seconds and works once; `session` binding takes the sign-in token Cloudflare Access and oauth2-proxy send instead. A token that verifies names the person, and Clawboo records them on approvals (`resolvedBy`), team chat and 1:1 chat messages, task comments, and the board events for creating, moving, assigning and linking tasks. A forged, unsigned, expired, replayed or wrongly bound token is refused with `401`, never let through as an unnamed person. With `required`, a request without a good token is refused too, so an agent that reads the access token file can no longer use the API as a person.

**Beside the access token.** While the access token is on, requests still need it. `GET /api/access/identity` says which mode is on and who the request is, the capabilities route reports `auth.proxyIdentity`, and **Settings** > **System** > **Deployment** shows the mode. It adds names, not permissions: everyone who gets through the proxy can still do everything, and the records live in a database programs running as Clawboo's user can change. See the new guide, Run Clawboo behind a sign-in proxy.
