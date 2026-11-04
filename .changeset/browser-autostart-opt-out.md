---
'clawboo': patch
---

The browser connectors can be kept from starting, and start lighter when they do.

`CLAWBOO_DISABLE_BROWSER_AUTOSTART=1`, `disableBrowserAutostart` in the operator settings file, or the **Start the browsers on a new install** switch in **Settings** > **System** > **Deployment** stops Clawboo starting Playwright and Chrome DevTools on an install that has never had them. Browsers you connected still come back after a restart.

When the exact version Clawboo pins is already installed, in npx's cache or beside Clawboo, each browser now starts from that copy instead of through `npx`, which kept an `npm exec` process running beside every browser and asked the registry on every start. Any other version still goes through `npx`. Chrome DevTools now runs with its usage statistics and its daily check for a newer version off, unless the server's own environment sets `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` or `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`.
