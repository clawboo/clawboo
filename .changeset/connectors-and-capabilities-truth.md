---
'clawboo': patch
---

Agents are told only about connectors shared with them, and several status reports now match what is set up.

**Connectors an agent was not given are not named to it.** The connectors note on a turn you read listed every connector you had connected as usable, including ones never shared with that agent. That told the agent it could use tools it could not see, and told it which apps you had connected for other agents. It now names only the connectors whose tools that agent actually has, and never offers one you already connected as something to add. An OpenClaw agent reaches Clawboo's tools through one setting all OpenClaw agents share, so it is told only about connectors shared with every agent, not the browser each agent is given at first start. A Clawboo Native agent whose tools MCP server is switched off is told about none.

**Approving an OpenClaw command through `POST /api/capabilities/approve` releases it.** It used to mark the approval answered while the Gateway kept holding the command. It now answers through the Gateway, exactly as `POST /api/tools/approvals/:id/resolve` does.

**Codex rows read Ready after `codex login`.** In **Settings > Capabilities**, Codex's Clawboo server rows read **Pending auth** before you sign in to Codex and **Ready** after, instead of **Pending auth** always.

**Clawboo Native refuses a key for a provider it cannot run on.** `POST /api/runtimes/clawboo-native/connect` with a provider such as `minimax` answers `400 unknown provider` instead of storing that key as your Anthropic key.

**Smaller fixes.**

- `GET /api/providers` lists, in `poweredRuntimes`, every runtime that reads the provider's key: Clawboo Native for every provider it can drive, and Hermes for Anthropic and OpenAI keys too.
- OpenClaw keys held by any agent count as configured in `GET /api/system/openclaw-config` and `GET /api/system/models`, not only the first agent that has a key.
- `team_chat_subscribe` no longer skips posts when `limit` cuts a page short: the next read starts after the last post returned.
- The `memory_search` tool tells agents the default mode correctly: hybrid when an embedding provider is set up, otherwise keyword.
