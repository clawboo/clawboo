// Real Codex driver — spawns `codex exec --json` in an ISOLATED `CODEX_HOME`
// (never touches the user's `~/.codex`), with a generated `config.toml` that
// points Codex's MCP client at clawboo's hosted Tasks/Memory/Tools servers. The
// stdout JSON-lines stream is parsed best-effort into the adapter's
// `CodexNativeEvent` union; a terminal `result` is ALWAYS synthesized on process
// exit (the reliable lifecycle backbone) if the stream didn't already produce
// one. Codex reports no USD — the mapper marks cost estimated.
//
// The exact `codex exec --json` event field names — AND the `codex exec resume
// [SESSION_ID] [PROMPT]` subcommand with the same `--json` / bypass flags — are
// confirmed against the installed CLI (0.136); the parser is tolerant of shape
// drift and the exit-synthesized terminal keeps a run correct regardless.
//
// HOMES. Two kinds, decided by `ctx.homeDir` (computed by the caller from the
// adapter's integration plan — drivers never re-derive it):
//   - MANAGED (persistent, per-identity — `~/.clawboo/runtimes/codex/<agentId>/`):
//     what gives a Codex LEADER conversational continuity — the CLI's session
//     files under $CODEX_HOME/sessions/ survive between turns so `ctx.resume`
//     (a thread id) can `codex exec resume` them.
//   - THROWAWAY (mkdtemp): the legacy per-run fallback when no homeDir is given.
//
// AUTH SEEDING (the Paperclip codex-local pattern). The user's `codex login`
// OAuth (`~/.codex/auth.json`) is SEEDED into the run home — never written back.
// For a MANAGED home the seed is an mtime FRESHNESS DECISION, not a blind copy:
// the CLI rotates the refresh token INSIDE the managed home's auth.json, so
// re-copying an older user file over it would replay a consumed refresh token
// ("refresh_token_reused"). And a managed run FAILS FAST with an explicit error
// when no usable credential is provisioned — never an unauthenticated request.

import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Does this auth.json hold a USABLE credential? Parse-validated (never a blind
 * file-exists check — the Paperclip `hasUsableAuthPayload` pattern): usable means
 * an OAuth `tokens` object carrying a non-empty access or refresh token, or a
 * non-empty `OPENAI_API_KEY` field. Unreadable/unparseable ⇒ unusable.
 * Exported for the driver tests.
 */
export function hasUsableCodexAuth(authPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as {
      tokens?: { access_token?: unknown; refresh_token?: unknown } | null
      OPENAI_API_KEY?: unknown
    }
    const t = parsed.tokens
    if (t && typeof t === 'object') {
      if (typeof t.access_token === 'string' && t.access_token.length > 0) return true
      if (typeof t.refresh_token === 'string' && t.refresh_token.length > 0) return true
    }
    return typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0
  } catch {
    return false
  }
}

/**
 * Seed the user's `codex login` OAuth into the run home. Copy-only — NEVER
 * writes back to `~/.codex`. For a persistent (managed) home this is a
 * FRESHNESS DECISION: the codex CLI rotates the refresh token inside the
 * managed home's own auth.json, so the user's copy only replaces it when the
 * user's file is NEWER (a re-login) or the managed one is missing/unusable —
 * a blind re-copy would replay an already-consumed refresh token
 * ("refresh_token_reused"). Best-effort: seeding failures never throw.
 * Exported for the driver tests.
 */
export async function seedCodexAuth(codexHome: string): Promise<void> {
  try {
    const src = userCodexAuthPath()
    if (!existsSync(src)) return
    const dst = path.join(codexHome, 'auth.json')
    if (existsSync(dst) && hasUsableCodexAuth(dst)) {
      const [srcStat, dstStat] = await Promise.all([stat(src), stat(dst)])
      if (srcStat.mtimeMs <= dstStat.mtimeMs) return // managed token is as fresh or fresher
    }
    await copyFile(src, dst)
  } catch {
    /* best-effort — auth seeding is not fatal to constructing the plan */
  }
}

/**
 * The `codex exec` argv, pure for tests. A `resume` (a prior thread id) turns the
 * run into `codex exec resume <id> …` — same flags, confirmed against the 0.136
 * CLI (`codex exec resume --help` lists --json + both bypass flags).
 */
export function buildCodexExecArgs(opts: {
  prompt: string
  model?: string | null
  resume?: string | null
}): string[] {
  return [
    'exec',
    ...(opts.resume ? ['resume', opts.resume] : []),
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    ...(opts.model ? ['--model', opts.model] : []),
    opts.prompt,
  ]
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
      // MANAGED (persistent, per-identity) home when the caller resolved one from
      // the adapter's integration plan; the legacy throwaway mkdtemp otherwise.
      const managed = Boolean(ctx.homeDir)
      const codexHome =
        ctx.homeDir ?? (await mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-home-')))
      if (managed) await mkdir(codexHome, { recursive: true, mode: 0o700 })
      // Seed the user's ChatGPT-OAuth login so the run authenticates with their
      // `codex login` account. Freshness-aware for a managed home (see seedCodexAuth);
      // never writes back to ~/.codex.
      await seedCodexAuth(codexHome)
      // FAIL-FAST guard (managed homes only — the Paperclip codex-local pattern):
      // no usable provisioned credential + no API key env ⇒ an explicit error the
      // engine can reflect, never an unauthenticated request with a cryptic 401.
      // The throwaway path keeps its historic lenient behavior (codex surfaces its
      // own auth error), so nothing else changes shape.
      if (
        managed &&
        !hasUsableCodexAuth(path.join(codexHome, 'auth.json')) &&
        Object.keys(ctx.apiKeyEnv ?? {}).length === 0
      ) {
        throw new Error(
          `no Codex credentials provisioned for managed home ${codexHome} — ` +
            'run `codex login` in your terminal, then retry',
        )
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
      // A prior thread id (ctx.resume) continues that session via `exec resume` —
      // only meaningful for a managed home, whose sessions/ dir persists.
      const args = buildCodexExecArgs({
        prompt,
        model,
        resume: managed ? (ctx.resume ?? null) : null,
      })
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
