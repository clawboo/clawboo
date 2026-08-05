---
title: '@clawboo/protocol'
description: Message parser, transcript types, and agent file definitions for Clawboo. Pure, browser-safe, zero-dep.
---

- **Version** 0.1.0 · **Purity** pure zero-dep (browser-safe)
- **Purpose** Parse runtime/Gateway message frames into typed text/thinking/tool blocks, and define the canonical `TranscriptEntry` shape its consumers order and store.
- **Workspace deps** none
- **External deps** none (devDependency: `@clawboo/tsconfig`)

A single flat barrel, no subpath exports. All consumers import from `@clawboo/protocol`.

## Public API

### Functions

#### Text extraction

- `extractText(message: unknown): string | null`, pull display text from a message; strips the `[[reply_to_current]]` assistant prefix + thinking tags (assistant role), or the channel envelope + appended exec-approval-wait policy (other roles).
- `extractThinking(message: unknown): string | null`, extract reasoning from block content, direct fields (`thinking`/`analysis`/`reasoning`/…), or tagged streams.
- `extractThinkingFromTaggedText(text: string): string`, extract content between closed `<think>`/`<analysis>`/`<thought>`/`<antthinking>` tags only.
- `extractThinkingFromTaggedStream(text: string): string`, like above but also returns the tail after a still-open thinking tag (streaming in progress).

#### Tool extraction

- `extractToolCalls(message: unknown): ToolCallRecord[]`, read `type: 'toolCall'` items from array content → `{ id?, name?, arguments }`.
- `extractToolResult(message: unknown): ToolResultRecord | null`, read a `role: 'toolResult' | 'tool'` message → `{ toolCallId?, toolName?, details, isError?, text }`.
- `extractToolLines(message: unknown): string[]`, format any tool calls + result as `[[tool]]`/`[[tool-result]]` markdown lines.

#### Markdown formatting & parsing

- `formatToolCallMarkdown(call: ToolCallRecord): string`, render a tool call as a `[[tool]]` line with a fenced JSON args block.
- `formatToolResultMarkdown(result: ToolResultRecord): string`, render a tool result as a `[[tool-result]]` line with status meta + fenced text body.
- `parseToolMarkdown(line: string): ParsedToolMarkdown`, split a `[[tool]]`/`[[tool-result]]` line into `{ kind, label, body }`.
- `formatMetaMarkdown(meta): string`, serialize `{ role, timestamp, thinkingDurationMs? }` to a `[[meta]]` JSON line.
- `parseMetaMarkdown(line): { role, timestamp, thinkingDurationMs? } | null`, parse a `[[meta]]` line back; null on invalid/missing role or non-positive timestamp.

#### Markdown type guards

- `isTraceMarkdown(line: string): boolean`, line starts with `[[trace]]`.
- `isToolMarkdown(line: string): boolean`, line starts with `[[tool]]` or `[[tool-result]]`.
- `isMetaMarkdown(line: string): boolean`, line starts with `[[meta]]`.

#### UI-metadata helpers

- `stripUiMetadata(text: string): string`, remove reset/system-event/project-path injections, `[message_id:…]` tags, and the channel envelope.
- `isHeartbeatPrompt(text: string): boolean`, text is a `Read HEARTBEAT.md…` prompt or carries a heartbeat-file-path line.

#### Main parser

- `parseMessage(raw: unknown): ParsedMessage`, full parse → `{ text, thinking, toolCalls, toolResults, metadata }`.

#### Agent helpers

- `isAgentFileName(value: string): value is AgentFileName`, type guard over `AGENT_FILE_NAMES`.

### Types & interfaces

- `ToolCall`: `{ id?, name, arguments: Record<string, unknown> }`.
- `ToolResult`: `{ toolCallId?, name, output, isError?, details? }`.
- `MessageMeta`: `{ role?, timestamp?, thinkingDurationMs? }`.
- `ParsedMessage`: `{ text, thinking, toolCalls, toolResults, metadata }`, the `parseMessage` return.
- `ParsedToolMarkdown`: `{ kind: 'call' | 'result', label, body }`.
- `ToolResultRecord`: `{ toolCallId?, toolName?, details, isError?, text? }`, the `extractToolResult` shape.
- `TranscriptEntryKind`: `'meta' | 'user' | 'assistant' | 'thinking' | 'tool'`.
- `TranscriptEntryRole`: `'user' | 'assistant' | 'tool' | 'system' | 'other'`.
- `TranscriptEntrySource`: `'local-send' | 'runtime-chat' | 'runtime-agent' | 'history' | 'legacy'`.
- `TranscriptEntry`: the canonical transcript row: `{ entryId, role, kind, text, sessionKey, runId, source, timestampMs, sequenceKey, confirmed, fingerprint }`. `fingerprint` is an **opaque per-entry id, not a content hash** — every producer mints a fresh UUID, and nothing derives identity from it. Dedup keys off `entryId`.
- `AgentFileName`: union of the 7 `AGENT_FILE_NAMES` literals.
- `AgentFileMeta`: `{ title, hint }`.

<Note>
`ToolCallRecord` is referenced in several function signatures above (`formatToolCallMarkdown`, `extractToolCalls`) but is a module-local type, **not exported** from the barrel.
</Note>

### Constants

- `AGENT_FILE_NAMES`: `readonly ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md']`.
- `AGENT_FILE_META: Record<AgentFileName, AgentFileMeta>`: `{ title, hint }` per file.
- `AGENT_FILE_PLACEHOLDERS: Record<AgentFileName, string>`: editor placeholder text per file.

## Used by

- `@clawboo/events`, Bridge parsers reuse `extractText` / `parseMessage` / `isReasoningStream` shapes for the policy pipeline.
- `@clawboo/adapter-openclaw`, maps Gateway frames → `RuntimeEvent` via the pure `parseChatPayload`/`parseMessage`/`extractText` helpers.
- `apps/web` chat + group-chat surfaces, `parseToolMarkdown`, the `[[tool]]`/`[[trace]]`/`[[meta]]` guards, the `TranscriptEntry` shape, and `AGENT_FILE_NAMES` / `AGENT_FILE_META` for the agent file editor.
- `@clawboo/agent-registry`, mirrors `AGENT_FILE_NAMES` locally to stay dependency-free (does not import this package).

## Source

Barrel: [`packages/protocol/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/protocol/src/index.ts) (single flat module; no subpath exports in `package.json`).

## See also

- [@clawboo/events](/reference/packages/events), the Bridge → Policy → Handler event pipeline that consumes these parsers.
- [@clawboo/adapter-openclaw](/reference/packages/adapter-openclaw), Gateway frame → `RuntimeEvent` mapping.
- [Gateway & events](/concepts/gateway-and-events), how raw frames flow through the system.
- [Transcript ordering (sequenceKey)](/concepts/gateway-and-events), why `timestampMs` + `sequenceKey` is the sort key.
