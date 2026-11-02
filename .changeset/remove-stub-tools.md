---
'clawboo': patch
---

Agents are no longer offered two tools that did nothing. `web_search` only repeated the query back and appeared once `TAVILY_API_KEY` was set, and `delete_path` deleted nothing. Clawboo's own tools are now `echo` and `note`; for web search, connect a search connector such as Exa and give it to the agents that need it.
