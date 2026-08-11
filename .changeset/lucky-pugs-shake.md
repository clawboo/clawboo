---
'clawboo': patch
---

Enabling or disabling an OpenClaw Gateway tool from the Capabilities dashboard now works. The panel offered the button and the request came back rejected every time, because the rule for which rows a source can write was spelled out twice: once where a record is read back from the database, and once in the OpenClaw source that performs the write. They disagreed. The database copy said no OpenClaw config row is writable, which also caught the `tools.allow`/`tools.deny` rows that are in fact the one Gateway write Clawboo supports, so the dashboard rendered a button whose only possible outcome was a 422. Both sides now read one shared predicate, so what the panel offers and what the server allows cannot drift apart again. MCP connectors and plugins stay read-only, since writing those is still unimplemented.

Fixed a second defect in the same write, which that gate had been hiding: it read the Gateway config from the top level of the `config.get` response instead of unwrapping the snapshot, so on current OpenClaw the existing tool lists read as empty and the patch replaced the whole `tools.allow`/`tools.deny` policy with just the tool being toggled. That would have discarded every other allow and deny entry, including the `sessions_spawn` and `sessions_yield` denies Clawboo relies on to stop agents spawning sub-agents. Toggling a tool now preserves the rest of the policy.

A toggle attempted while the Gateway is offline now answers 503 with a plain `gateway_disconnected` rather than surfacing a raw error string in the toast.
