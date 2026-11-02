---
'clawboo': patch
---

The default browser access can browse. Playwright marks nearly every tool destructive, navigate and click included, so the write access each agent gets for the browser only allowed reading the page. The catalog now names Playwright's truly destructive tools itself (running arbitrary code and handing local files to a site); those still need admin access, and every other action works with write access and asks first under the default policy. Chrome DevTools marks nothing destructive, so the catalog names its two dangerous tools too: running script in the page and uploading a local file now need admin access.

Neither browser can open the Clawboo dashboard. Both start with the dashboard's address on this computer blocked, on the port the server really uses, and Clawboo refuses any connector call that points at it, so an agent cannot use a browser to approve its own requests or give itself connectors. Other local addresses stay reachable.
