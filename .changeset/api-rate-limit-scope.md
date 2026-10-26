---
'clawboo': patch
---

Loading the dashboard no longer counts against the API's request limit. The dashboard's script files, fonts and page shell were counted twice, once under their own limit and once under the API's, so a run of page loads could make the API answer "Too many requests" while API traffic itself was far below the limit. Those files now count only under their own limit, and both limits are unchanged.
