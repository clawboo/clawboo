---
title: '@clawboo/compaction'
description: 'Pass-through-safe, failure-preserving tool-output compaction: cuts verbose tool output before it re-enters context, never compressing away an error.'
---

- **Version** `0.1.0`
- **Purity** pure zero-dep (browser-safe; no workspace or external deps, no `node:*`)
- **Purpose** Cut verbose tool output before it re-enters an agent's context, with two guarantees: pass-through-safe (tiny inputs / low-savings return untouched) and failure-preserving (an error line in the input is guaranteed to survive into the output).
- **Workspace deps** none
- **External deps** none

Runs client-side or server-side between an adapter's `tool-result` and context insertion. The whole package is pure string transforms, no process spawning, no I/O. The single `.` entry point has no subpath exports. UTF-8 byte length is measured via the global `TextEncoder` (Node 22+/browsers).

The two invariants in code: `compactToolOutput` returns the original (with `applied: false`) when the input is below `minBytes` (default 512), when the compaction would drop a failure line, or when savings fall below `minSavings` (default 0.05). Every call returns `stats` so a bad rule is auditable.

## Public API

### Functions

| Signature                                                                                                    | Contract                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compactToolOutput(toolName: string, output: string, opts?: CompactOptions): CompactionResult`               | Compact one tool's output. Picks the first matching rule (overlay `opts.rules` → builtins → the `dedup-elide` catch-all), then an always-safe URL-shortening pass. Returns the original with `applied: false` for `passthrough-small` (`< minBytes`), `failure-preserve-fallback` (a rule dropped an error line), or `passthrough-low-savings` (`< minSavings`). |
| `compactToolResultMarkdown(text: string, opts?: CompactOptions): { text: string; stats: CompactionStats[] }` | Rewrite the verbose body of every embedded `[[tool-result]] … ```text…``` block in a text blob (the `formatToolResultMarkdown`shape), leaving prose between blocks untouched. Each block is routed through`compactToolOutput`; an un-applied block is left verbatim. Returns the rewritten text + per-block stats.                                               |
| `compactGitStatus(output: string): string`                                                                   | Version-control-status rule body: keep branch lines, section headers, and changed/porcelain file lines; drop the `(use …)` hints. Returns the original when nothing matched.                                                                                                                                                                                     |
| `compactTestOutput(output: string): string`                                                                  | Test-runner rule body: keep every failure line and summary line (`Tests:` / `N passed` / etc.); drop pass lines (`✓` / `PASS` / `ok N`). Returns the original when nothing matched.                                                                                                                                                                              |
| `htmlToText(output: string): string`                                                                         | HTML-to-text rule body: strip `<script>`/`<style>`/comments, map block-closing tags + `<br>` to newlines, remove remaining tags, decode the common entities, collapse blank runs. Linear, no parser dependency.                                                                                                                                                  |
| `shortenUrls(output: string): string`                                                                        | Always-safe final pass: any `http(s)://…` URL longer than 80 chars is collapsed to `<host>/…[+N chars]`.                                                                                                                                                                                                                                                         |
| `dedupAndElide(output: string, opts?: { headLines?: number; tailLines?: number }): string`                   | The catch-all when no content rule matches: collapse consecutive identical lines into `<line>  (×N)`, then keep `head` (default 40) + `tail` (default 20) lines, eliding the middle; but every failure line in the elided middle is pulled out and kept.                                                                                                         |
| `failureLines(text: string): string[]`                                                                       | Extract every line matching `FAILURE_RE` (the safety check's source of truth).                                                                                                                                                                                                                                                                                   |

### Types & interfaces

| Name               | Shape / contract                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompactionStats`  | `{ rule: string; originalBytes: number; compactedBytes: number; applied: boolean }`, what one pass did. `rule` is the rule id that fired, or a `passthrough-*` / `failure-preserve-fallback` reason when nothing was kept. `applied` is true only when the output was actually changed and kept.                      |
| `CompactionResult` | `{ text: string; stats: CompactionStats }`.                                                                                                                                                                                                                                                                           |
| `CompactionRule`   | `{ id: string; matches(toolName: string, output: string): boolean; compact(output: string): string }`, a content-sniffing rule (matched by tool name + output shape).                                                                                                                                                 |
| `CompactOptions`   | `{ rules?: CompactionRule[]; minBytes?: number; minSavings?: number }`; `rules` are overlay rules tried BEFORE the builtins (project → user precedence); `minBytes` skips compaction below that many input bytes (default 512); `minSavings` keeps the result only if it saves at least that fraction (default 0.05). |

### Classes

None; this package exports only functions, types, and constants.

### Constants

| Name               | Value / contract                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILTIN_RULES`    | The builtin `CompactionRule[]`, content-sniffed in order: `git-status` → `test-output` → `html-to-text`. Overlay rules are tried first; the `dedup-elide` catch-all runs when none match. |
| `FALLBACK_RULE_ID` | `'dedup-elide'`, the `stats.rule` value used when no content rule matched (the `dedupAndElide` catch-all fired).                                                                          |
| `FAILURE_RE`       | The regex that defines a "failure" line (`error`, `exception`, `traceback`, `fatal`, `failure`, `failed`, `panic`, `✗`/`✘`/`✖`/`×`, …), case-insensitive. These lines are never elided.   |

<Info>
Failure-preserving is enforced at the package boundary, not by trusting each rule. After a rule transforms the output, `compactToolOutput` re-runs `failureLines` over the original and falls back to the untouched input (`failure-preserve-fallback`) if any failure line did not survive as a substring. A buggy overlay rule cannot silently swallow an error.
</Info>

## Used by

- **`@clawboo/db`**; `tools/broker.ts` runs `compactToolOutput(call.name, raw).text` over a brokered tool call's result (unless `opts.compact === false`), so the broker pipeline compacts tool output before it returns.
- **`apps/web` (server)**; `lib/executorRunner.ts` passes `compactToolResultMarkdown(text).text` as the runner's `compact` dep, applied to a child's report-up summary before it becomes a board comment / `[Task Update]`.
- **`apps/web` (server)**; `lib/teamChat/teamOrchestrator.ts` wires `compactToolResultMarkdown(text).text` as the server-side team orchestrator's `compact` dep.

## Source

Barrel: [`packages/compaction/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/compaction/src/index.ts) (re-exports `./compact`, `./rules`, and the `./types` types).

## See also

- [`@clawboo/db`](/reference/packages/db), the tool broker that compacts brokered results
- [`@clawboo/executor`](/reference/packages/executor), the `RuntimeEvent` `tool-result` this sits behind
- [Observability concepts](/concepts/observability)
- [Package overview](/reference/packages/index)
