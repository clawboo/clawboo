---
title: 'Website logins API'
sidebarTitle: 'Website logins'
description: 'REST reference for the website logins agents sign in with and the 1Password connection. No answer ever carries a username, password, one-time code key or token.'
keywords: ['website logins', 'fill_login', '1Password', 'service account', 'vault', 'password']
---

These routes save, list, change and remove the [website logins](/using/website-logins) a person's agents can sign in with, and connect that person's 1Password. Every route is a person's: it passes the [person check](/operating/security#the-person-check) or answers `403 { "ok": false, "error": "person_only" }`, and it acts for that person. A person a sign-in proxy vouched for sees and changes only their own logins; the dashboard on an install with one person acts as its one person.

Examples use the default port `18790`. Add the access cookie to each `curl`, as shown under [Authentication](/reference/rest-api/index#authentication). Writes count against the stricter sensitive limit (see the [REST API overview](/reference/rest-api/index)).

**No answer carries a value.** A username, password, one-time code key or 1Password token goes in once and is never read back. An error is a code from the lists below, never the request's own text.

## Routes

| Method | Path                                            | Summary                                    | Limit     |
| ------ | ----------------------------------------------- | ------------------------------------------ | --------- |
| GET    | `/api/website-logins`                           | List your logins and your 1Password status | general   |
| POST   | `/api/website-logins`                           | Save a login                               | sensitive |
| PATCH  | `/api/website-logins/:id`                       | Change a login                             | sensitive |
| DELETE | `/api/website-logins/:id`                       | Remove a login                             | sensitive |
| POST   | `/api/website-logins/sources/1password/install` | Install 1Password support, once            | sensitive |
| PUT    | `/api/website-logins/sources/1password`         | Connect 1Password with a service account   | sensitive |
| DELETE | `/api/website-logins/sources/1password`         | Forget the 1Password token                 | sensitive |

## GET /api/website-logins

```json
{
  "ok": true,
  "logins": [
    {
      "id": "Wq1p0uB7mJr3bXyA",
      "origin": "https://example.com",
      "label": "Work account",
      "hasUsername": true,
      "hasOneTimeCode": false,
      "createdAt": 1762851000000,
      "updatedAt": 1762851000000
    }
  ],
  "onePassword": {
    "connected": true,
    "connectedAt": 1762851200000,
    "sdkInstalled": true,
    "sdkInstalling": false
  },
  "fillAvailable": true
}
```

`fillAvailable` is whether a browser connector (Playwright or Chrome DevTools) is connected. When it is `false`, `fill_login` is not offered to any agent.

## POST /api/website-logins

Body: `site` (required), `password` (required), and optional `username`, `oneTimeCodeSecret` and `label`.

- `site` is a host or an address. Clawboo keeps its origin; a bare host is read as `https`. Plain `http` is refused except on `localhost`, `127.0.0.1` and `[::1]`.
- `oneTimeCodeSecret` is the base32 setup key a site shows for an authenticator app (spaces and dashes are ignored).
- Limits: username 512 characters, password 1,024, key 256, label 120.

```bash
curl -s -X POST http://localhost:18790/api/website-logins \
  -H 'content-type: application/json' \
  -d '{"site":"example.com","username":"me@example.com","password":"…","label":"Work account"}'
```

Answers `201 { "ok": true, "login": { … } }` with the same fields as a list entry.

| Error                   | Status | When                                          |
| ----------------------- | ------ | --------------------------------------------- |
| `invalid_body`          | 400    | `site` or `password` is missing               |
| `invalid_site`          | 400    | `site` is not an http(s) address with a host  |
| `insecure_site`         | 400    | Plain `http` off loopback                     |
| `missing_password`      | 400    | `password` is empty                           |
| `invalid_one_time_code` | 400    | The key is not base32 of 16 to 256 characters |
| `too_long`              | 400    | A value is over its limit                     |
| `exists`                | 409    | You already saved a login for that origin     |

## PATCH /api/website-logins/:id

Every field is optional; a field you leave out keeps its value.

- `password`: a new password. An empty string keeps the old one.
- `username`: a new username. An empty string clears it.
- `oneTimeCodeSecret`: a new key, or `null` (or an empty string) to remove it.
- `site`, `label`: as for POST. An empty `label` clears it.

Answers `{ "ok": true, "login": { … } }`, or `404 not_found` for a login that is not yours, plus the POST errors.

## DELETE /api/website-logins/:id

Answers `{ "ok": true }`, or `404 not_found` for a login that is not yours.

## PUT /api/website-logins/sources/1password

Body: `{ "token": "ops_…" }`, a 1Password service account token. Clawboo checks the token by listing the vaults it can read, and saves it in the vault only when it can read at least one. It replaces your earlier token.

Answers `{ "ok": true, "vaults": 2 }`: how many vaults it can read, never their names.

| Error           | Status | When                                                                 |
| --------------- | ------ | -------------------------------------------------------------------- |
| `invalid_token` | 400    | Empty, over 8,192 characters, or containing spaces                   |
| `rejected`      | 400    | 1Password refused the token, or it can read no vault                 |
| `unreachable`   | 502    | 1Password could not be reached                                       |
| `sdk_missing`   | 409    | 1Password support is not installed yet: call the install route first |

## POST /api/website-logins/sources/1password/install

Downloads 1Password's SDK, version 0.5.0 (about 14 MB), into the [runtimes folder](/operating/data-and-state#the-runtimes-folder), once. It is not part of Clawboo's own install. The first call takes as long as the download; a second call while one runs waits for the same one, and a call after it is installed answers at once. `GET /api/website-logins` reports `onePassword.sdkInstalled` and `onePassword.sdkInstalling`.

Answers `{ "ok": true }`, or `502` with:

| Error             | When                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `install_offline` | The download failed on the network: offline, a proxy, a certificate                                      |
| `install_failed`  | Anything else, such as no npm or a runtimes folder Clawboo will not use. The server's log has npm's code |

## DELETE /api/website-logins/sources/1password

Forgets your token. Answers `{ "ok": true }`.

## Related

- [Let agents sign in to websites](/using/website-logins)
- [The `fill_login` tool](/reference/mcp-tools#fill_login)
