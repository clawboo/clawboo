---
'clawboo': patch
---

Keep agents' browsers off the Clawboo dashboard on every hop, and off the files on this computer. Playwright applied its dashboard block only to the address an agent opened, so a local page that redirected to the dashboard loaded it, and neither browser stopped a page's WebSocket to the dashboard's port. Both browsers now start with Chrome host rules that refuse the dashboard's addresses on its port, so a redirect, a page's script or a WebSocket cannot reach it either, and Chrome DevTools now blocks every `127.x.x.x` address on that port too. Chrome DevTools also opened `file:` addresses and showed the file to the agent, and Playwright opened `view-source:file:` ones. Chrome DevTools now refuses `file:` and `view-source:` addresses itself, and the broker refuses any call whose `url` argument would open a file on this computer in either browser, including a Windows drive or network path.
