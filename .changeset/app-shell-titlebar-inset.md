---
'clawboo': patch
---

The app shell pads its top by the `--clawboo-titlebar-inset` CSS custom property, so an app that embeds the dashboard can draw its own title bar, such as an inset macOS one, without covering the sidebar. Unset, it is 0 and nothing changes.
