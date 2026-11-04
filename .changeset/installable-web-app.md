---
'clawboo': patch
---

Install the dashboard as a web app, and use the board and chats at a phone's width.

**Installable.** The dashboard serves a web app manifest with the Boo icons, so Chrome and Safari offer to add it to the home screen, where it opens in a window of its own. Every URL in the manifest is relative, so the installed app starts at the dashboard's mount, under `CLAWBOO_BASE_PATH` too, and nothing it opens carries a query. The manifest and its icons load without the access cookie, the shell asks for it with `crossorigin="use-credentials"` for a sign-in proxy that needs one, and the API still needs the cookie. There is no service worker, so nothing is cached for offline use. The `theme-color` follows the light or dark theme. A phone's browser offers the install only over HTTPS; see the remote access guide.

**Phone width.** Narrower than 640 px, the sidebar opens as a drawer over the page from the button at the start of each header, and closes on Escape, a tap beside it, or the move to another page. It keeps its own state and never changes the docked sidebar's collapsed setting. The board shows one column at a time, a screen wide with Needs you first, and stops at each column as it is swiped. An agent's page and a team's chats show the chat alone, and each card opens over the whole screen and closes back to the chat, without changing which cards the wide layout keeps open. The app fills the visible viewport (`100dvh`), so a phone browser's toolbars no longer cover the message box. Headers drop the GitHub star and other extras to keep their names readable, and New task's buttons wrap instead of running off the dialog.

**Board header.** The board now has the sidebar button the other pages have, so a collapsed sidebar can be reopened from it without the keyboard shortcut.
