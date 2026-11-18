---
title: "Show the dashboard in an app's own window"
sidebarTitle: 'App window'
description: 'For an app that shows the Clawboo dashboard in its own window with the title bar hidden: keep the window buttons off the sidebar with --clawboo-titlebar-inset, and ask for the slim top bar with data-clawboo-embed-titlebar.'
keywords:
  [
    'embed',
    'window',
    'title bar',
    'titlebar',
    'hidden title bar',
    'traffic lights',
    'drag',
    '--clawboo-titlebar-inset',
    '--clawboo-titlebar-left',
    'data-clawboo-embed-titlebar',
    'ui.embedTitlebar',
  ]
---

An app that shows the dashboard in its own window, with the system title bar hidden, draws the window's buttons (close, minimise, zoom) over the page. Two CSS custom properties and one attribute on the page's `<html>` element tell the dashboard where those buttons are, and ask it for a slim top bar of its own.

In a browser tab none of this is set, and the dashboard looks as it always has.

## Keep the window buttons off the sidebar

Set `--clawboo-titlebar-inset` to the height of the strip the window buttons sit in. The dashboard leaves that much room at the top, above the sidebar and the page, so the buttons never cover either. Unset, it is `0`.

Set it on `<html>`, or on any element above the dashboard: the dashboard reads it with a fallback of `0` rather than defining it itself, so the value you set always wins.

## Ask for the slim top bar

From 0.9.0, set `data-clawboo-embed-titlebar` on `<html>` as well, and the strip becomes a slim bar in the dashboard's own frame colour, the same as the team rail's:

- **Left**, after the window buttons: the button that hides and shows the sidebar, then back and forward through the dashboard's own pages. Back and forward are greyed out until there is somewhere to go.
- **Middle**: the team the page belongs to, with its icon, or the page's name, such as **Board**.
- **Right**: **Needs you**, which opens the Board's Needs you, and **Help**, which opens these docs in a new tab.

| Set on `<html>`               | What it does                                                                                                | Unset           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------- |
| `--clawboo-titlebar-inset`    | The strip's height, and the bar's. The sidebar and the page start below it.                                 | `0`             |
| `--clawboo-titlebar-left`     | The width the window buttons take from the left edge. The bar's buttons start after it. From 0.9.0.         | `0`             |
| `data-clawboo-embed-titlebar` | Draws the slim top bar in the strip. You can set it or remove it at any time; the page follows. From 0.9.0. | No bar is drawn |

For example, on macOS with an inset title bar:

```html
<html
  data-clawboo-embed-titlebar
  style="--clawboo-titlebar-inset: 36px; --clawboo-titlebar-left: 80px"
></html>
```

Or from a script your app runs in the page:

```js
const root = document.documentElement
root.style.setProperty('--clawboo-titlebar-inset', '36px')
root.style.setProperty('--clawboo-titlebar-left', '80px')
root.setAttribute('data-clawboo-embed-titlebar', '')
```

Under the bar, everything to the right of the team rail sits on one sheet: a faint line in the divider colour runs along its top and down its left side, and the two meet in a rounded corner, so the bar and the rail read as a frame around the page. In a browser tab, where the sidebar starts at the top of the page, the sidebar keeps its plain edges.

### The sidebar button

The sidebar's hide button moves out of the agent column into the bar, ahead of back and forward. It hides the sidebar, and once the sidebar is hidden it brings it back; hovering it then shows the sidebar under the bar without docking it. `Cmd/Ctrl + \` still hides and shows the sidebar. A window narrower than a phone's width works as in a browser: each page's header opens the sidebar as a drawer, and the bar shows no sidebar button.

### Moving the window

The bar is the window's drag area (`-webkit-app-region: drag`), so pressing its empty space and dragging moves the window, and double-clicking it does whatever the window does on a double-click, such as zoom on macOS. Its buttons are not part of the drag area, so a click on one always reaches the button.

### Back and forward

The dashboard keeps its own short history of the pages you moved between, up to 50 back, in the page's memory: a reload starts it empty. Back skips a page that is gone, such as a deleted team's chat or a deleted chat room. While the bar shows, `Cmd + [` and `Cmd + ]` (`Ctrl` on Windows and Linux) go back and forward, except while you are typing.

## Check that the server supports it

`GET /api/system/capabilities` reports `ui.embedTitlebar: true` from a server whose dashboard can draw the bar. An older server leaves the flag out. See [Feature flags](/reference/rest-api/system#feature-flags).

## Related

- [Tour the dashboard](/getting-started/dashboard-tour): the sidebar, its account bar and the page beside it.
- [An app that starts Clawboo](/guides/sso-proxy#an-app-that-starts-clawboo): naming the app's own people on the requests it sends.
