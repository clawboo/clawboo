---
'clawboo': minor
---

Sign in from the locked screen by pasting a one-time sign-in link.

**The locked screen has a Paste a sign-in link box.** Paste a link from **Open on another device** or `clawboo open --print`, or just its code, and press **Sign in**. This is how an app added to a phone's home screen gets in: on an iPhone or iPad that app keeps its cookies apart from Safari's, and a link you tap opens in Safari instead of the app. A pasted link is exactly as strong as an opened one. The box sends the code the way the server's own sign-in page does, so it works once, within two minutes, and sets the same cookie. The code never appears in the address bar, and nothing is stored in the browser.

**Only a link for this dashboard is accepted.** It must name the address the dashboard is open at, with the same `CLAWBOO_BASE_PATH`. A link for another address or another dashboard, a link that carries the access token, and text that is not a sign-in link are refused with a plain message, and nothing is sent. The box never opens the address you paste. A link that was already used or has expired comes back to the locked screen, which says so.

**Open on another device says how.** On an address a phone can reach, the dialog now says that an app on a phone's home screen signs in by pasting the link, next to its **Copy link** button.
