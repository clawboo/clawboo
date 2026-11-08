---
'clawboo': minor
---

An app that starts Clawboo itself, such as the desktop app, can now name the person behind each request it sends. It hands Clawboo its public key in `CLAWBOO_APP_LINK_PUBLIC_KEY` and signs a short token per request in the `clawboo-app-identity` header, for people whose ids start with `account:`. Such a request counts as that person's, so a message sent through the app can start work and records who asked, instead of reading as a local API call. These people can allow an approval once or deny it, but never allow it always. While the app's key is set, a sign-in proxy's token may not name an `account:` person, and a request that carries both kinds of token is refused; a sign-in proxy on its own works as before. A sign-in proxy's public key written on one line now also works when it ends in an escaped line break.
