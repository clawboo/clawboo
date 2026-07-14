// Real Codex driver — spawns `codex exec --json` in an ISOLATED `CODEX_HOME`
// (never touches the user's `~/.codex`), with a generated `config.toml` that
// points Codex's MCP client at clawboo's hosted Tasks/Memory/Tools servers. The
// stdout JSON-lines stream is parsed best-effort into the adapter's
// `CodexNativeEvent` union; a terminal `result` is ALWAYS synthesized on process
// exit (the reliable lifecycle backbone) if the stream didn't already produce
// one. Codex reports no USD — the mapper marks cost estimated.
//
// The exact `codex exec --json` event field names are confirmed against the
// installed CLI in the live smoke; the parser is tolerant of shape drift and the
// exit-synthesized terminal keeps a run correct regardless.
//
// The isolated home has no login of its own, so the user's `codex login` OAuth
// (`~/.codex/auth.json`) is SEEDED into it — copy-only, never written back — so a
// run authenticates with the account the user logged in with in their terminal.

import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CodexDriver, CodexNativeEvent } from '@clawboo/adapter-codex'
import { buildAttachConfig, mcpHttpUrl, MCP_SERVER_NAMES, type AttachScope } from '@clawboo/mcp'
import type { StartOpts } from '@clawboo/executor'

import { resolveRuntimeBin } from '../platform'
import { userCodexAuthPath } from './codexAuth'
import { createSpawnDriver } from './subprocess'
import type { RuntimeRunContext } from './types'

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function codexConfigToml(baseUrl: string, scope?: AttachScope): string {
  // mcpHttpUrl is the single source of truth for the URL shape; it appends the
  // run's scope to the shared Memory server only.
  return MCP_SERVER_NAMES.map((server) => {
    const url = mcpHttpUrl(baseUrl, server, scope)
    return `[mcp_servers.clawboo-${server}]\nurl = "${url}"\n`
  }).join('\n')
}

/** Mutable accumulators a Codex run threads through line parsing → close. */
interface CodexRunState {
  threadId?: string
  lastText: string
  usage: { inputTokens: number; outputTokens: number }
  sawResult: boolean
}

/** Best-effort translate of one Codex JSON event. Tolerant of shape drift. */
export function translateCodexEvent(raw: unknown, state: CodexRunState): CodexNativeEvent[] {
  const j = asRecord(raw)
  if (!j) return []
  const type = asStr(j['type']) ?? ''
  // `codex exec --json` (0.136) wraps a content ITEM as
  //   { type: 'item.completed', item: { type: 'agent_message' | 'reasoning' | …, text, … } }
  // and lifecycle as top-level { type: 'thread.started' | 'turn.completed', … }; an
  // older/other shape wraps content as { msg: { type, … } }. Unwrap item → msg → the
  // bare event so the inner type/text/usage are read regardless of the envelope.
  // WITHOUT the `item` unwrap, an `agent_message` reply was never captured, so the
  // run's summary came back EMPTY and the board fell back to "<title> completed."
  // (the "codex just echoes the prompt" bug — the run actually succeeded).
  const item = asRecord(j['item'])
  const msg = asRecord(j['msg'])
  const inner = item ?? msg ?? j
  const innerType = asStr(inner['type']) ?? type

  // Thread / session id (several plausible field spellings).
  const tid = asStr(j['thread_id']) ?? asStr(inner['thread_id']) ?? asStr(inner['session_id'])
  if (tid && !state.threadId) {
    state.threadId = tid
    return [
      {
        type: 'thread',
        threadId: tid,
        ...(asStr(inner['model']) ? { model: asStr(inner['model']) } : {}),
      },
    ]
  }

  // Incremental text delta (Responses-style) OR a whole agent message block.
  if (innerType.includes('output_text.delta')) {
    const delta = asStr(inner['delta']) ?? asStr(inner['text'])
    if (delta) {
      state.lastText += delta
      return [{ type: 'text', text: delta }]
    }
  }
  if (innerType.includes('agent_message') || innerType === 'message') {
    const text = asStr(inner['message']) ?? asStr(inner['text'])
    if (text) {
      state.lastText = text
      return [{ type: 'text', text }]
    }
  }
  if (innerType.includes('reasoning')) {
    const text = asStr(inner['text']) ?? asStr(inner['delta'])
    if (text) return [{ type: 'text', text, channel: 'reasoning' }]
  }

  // Tool / function call.
  if (
    innerType.includes('function_call') ||
    innerType.includes('tool_call') ||
    innerType.includes('exec_command')
  ) {
    const name = asStr(inner['name']) ?? asStr(inner['tool']) ?? 'tool'
    const id =
      asStr(inner['call_id']) ?? asStr(inner['id']) ?? `${name}-${state.usage.outputTokens}`
    return [{ type: 'tool-call', id, name, input: inner['arguments'] ?? inner['input'] ?? {} }]
  }

  // Usage accumulation (carried into the terminal cost event).
  const usage = asRecord(inner['usage'])
  if (usage) {
    state.usage.inputTokens += asNum(usage['input_tokens']) ?? 0
    state.usage.outputTokens += asNum(usage['output_tokens']) ?? 0
  }

  // Terminal completion.
  if (
    innerType.includes('completed') ||
    innerType.includes('task_complete') ||
    innerType.includes('turn.done')
  ) {
    state.sawResult = true
    return [
      {
        type: 'result',
        ok: true,
        summary: state.lastText,
        usage: state.usage.inputTokens || state.usage.outputTokens ? state.usage : undefined,
        ...(state.threadId ? { threadId: state.threadId } : {}),
      },
    ]
  }
  return []
}

export function createCodexDriver(opts: StartOpts, ctx: RuntimeRunContext): CodexDriver {
  const state: CodexRunState = {
    lastText: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    sawResult: false,
  }

  return createSpawnDriver<CodexNativeEvent>({
    async resolve() {
      const codexHome = await mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-home-'))
      // Seed the user's ChatGPT-OAuth login so the run authenticates with their
      // `codex login` account (the isolated home starts empty). Copy-if-present;
      // never write back to ~/.codex. If absent, the run falls back to whatever
      // ctx.apiKeyEnv provides (or fails with a clear auth error).
      try {
        const src = userCodexAuthPath()
        if (existsSync(src)) await copyFile(src, path.join(codexHome, 'auth.json'))
      } catch {
        /* best-effort — auth seeding is not fatal to constructing the plan */
      }
      if (ctx.mcpBaseUrl) {
        // Sanity: buildAttachConfig stays the source of truth for the URLs.
        void buildAttachConfig({
          runtime: 'codex',
          server: 'tasks',
          transport: 'http',
          httpBaseUrl: ctx.mcpBaseUrl,
        })
        await writeFile(
          path.join(codexHome, 'config.toml'),
          codexConfigToml(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined),
          'utf8',
        )
      }
      const prompt = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
      const model = ctx.model ?? opts.model
      // Headless: emit JSONL events; the worktree is our isolation, so bypass
      // Codex's own sandbox/approval prompts; the worktree is already a git repo.
      const args = [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        ...(model ? ['--model', model] : []),
        prompt,
      ]
      return {
        // Resolve to an absolute path (PATH first, then the user-install dirs) so
        // a shell-free spawn finds it on Windows and the resolved extension drives
        // the .cmd/.exe routing. Falls back to the bare name if unresolved.
        command: resolveRuntimeBin('codex') ?? 'codex',
        args,
        cwd: ctx.cwd ?? undefined,
        env: { CODEX_HOME: codexHome, ...(ctx.apiKeyEnv ?? {}) },
      }
    },
    parseLine(line: string): CodexNativeEvent[] {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return []
      }
      return translateCodexEvent(raw, state)
    },
    onClose(code, signal, _stdout, stderr): CodexNativeEvent[] {
      if (state.sawResult) return []
      // Idempotent across the subprocess substrate's 'error'+'close' double-fire
      // (createSpawnDriver invokes onClose from BOTH): mark the terminal as
      // synthesized so a second call returns [] (mirrors hermesDriver), never two
      // `result` terminals.
      state.sawResult = true
      // A deliberate abort kills the process with SIGTERM/SIGKILL (code null) —
      // surface it as a clean `aborted` terminal, not a spurious error.
      const aborted = signal === 'SIGTERM' || signal === 'SIGKILL'
      const ok = code === 0
      return [
        {
          type: 'result',
          ok,
          ...(aborted ? { aborted: true } : {}),
          summary: state.lastText,
          usage: state.usage.inputTokens || state.usage.outputTokens ? state.usage : undefined,
          ...(state.threadId ? { threadId: state.threadId } : {}),
          ...(ok || aborted
            ? {}
            : { errorMessage: stderr.trim() || `codex exited with code ${code}` }),
        },
      ]
    },
  })
}
