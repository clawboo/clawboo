// Real Codex driver. A run is hosted in `codex app-server` (see
// ./codexAppServerDriver), which is what lets a person steer it mid-turn; the
// `codex exec --json` driver below is the fallback for a Codex without app-server.
// Both share the home preparation here.
//
// The exec driver spawns `codex exec --json` in an ISOLATED `CODEX_HOME`
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

import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { CodexDriver, CodexNativeEvent } from '@clawboo/adapter-codex'
import { buildAttachConfig, mcpHttpUrl, MCP_SERVER_NAMES, type AttachScope } from '@clawboo/mcp'
import type { StartOpts } from '@clawboo/executor'

import { agentMkdir, agentReadFile, agentStat, agentWriteFile } from '../agentUser/agentFs'
import { isAgentUserMode } from '../agentUser/config'
import { resolveRuntimeBin } from '../platform'
import {
  agentCodexHome,
  hasUsableCodexAuthIn,
  usableCodexAuthBody,
  userCodexAuthPath,
} from './codexAuth'
import { createCodexAppServerDriver, type CodexAppServerDeps } from './codexAppServerDriver'
import { backendErrorText, codexFailureMessage } from './codexFailure'
import { makeThrowawayRuntimeHome } from './identityHome'
import { isContextOverflowMessage, rateLimitMessage } from './native/providers/types'
import { createSpawnDriver } from './subprocess'
import type { RuntimeRunContext } from './types'
import { terminalCommandName } from '../runtimeFolder'

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
    return usableCodexAuthBody(readFileSync(authPath, 'utf8'))
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
    const src = await codexSeedSource()
    if (!src) return
    // The run home is agent space, so its side is read and written through the
    // agent-space file verbs.
    const dst = path.join(codexHome, 'auth.json')
    const dstStat = await agentStat(dst)
    if (dstStat && (await hasUsableCodexAuthIn(codexHome))) {
      if (src.mtimeMs <= dstStat.mtimeMs) return // managed token is as fresh or fresher
    }
    // Owner-only, as the CLI keeps its own copy.
    await agentWriteFile(dst, src.data, { mode: 0o600 })
  } catch {
    /* best-effort — auth seeding is not fatal to constructing the plan */
  }
}

/**
 * Where a run home's login is copied from: the person's own `codex login`. With
 * agents on their own OS user, only that user's own login (the in-app sign-in,
 * run as the agent user, made it), read through the agent host. The person's own
 * is never copied into agent space then: any agent could read its refresh token
 * there, which is what running agents as their own user keeps from them. Null
 * when there is none.
 */
async function codexSeedSource(): Promise<{ data: Buffer; mtimeMs: number } | null> {
  const agentHome = agentCodexHome()
  if (agentHome) {
    const file = path.join(agentHome, 'auth.json')
    const st = await agentStat(file)
    const data = st?.type === 'file' ? await agentReadFile(file) : null
    if (st && data && usableCodexAuthBody(data.toString('utf8'))) {
      return { data, mtimeMs: st.mtimeMs }
    }
    return null
  }
  const src = userCodexAuthPath()
  if (!existsSync(src)) return null
  const [st, data] = await Promise.all([stat(src), readFile(src)])
  return { data, mtimeMs: st.mtimeMs }
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
  /** The failed turn's own reason, from the JSON stream (see codexFailureMessage). */
  streamError?: string
  /** The cause that reason names, when it is one the host acts on. */
  streamErrorCode?: 'context_overflow' | 'rate_limit' | null
}

// Re-exported for the driver tests, which reach every exec-path helper here.
export { codexFailureMessage }

/**
 * The cause of a failed turn on the `codex exec` stream, or null. The app-server types
 * its causes (`codexErrorInfo`); exec's JSON carries only text: the CLI's own "Codex ran
 * out of room in the model's context window. ..." (0.136, when the stream reports it),
 * or the backend's body, forwarded as a JSON string. Only the two causes that change
 * what happens next are read: an overflow drops the session, and a rate limit is worth
 * retrying, which its wording may not say ("too many tokens"). Only the turn's own error
 * is read, never stderr, which is the CLI's log.
 */
export function codexExecErrorCode(raw: string): 'context_overflow' | 'rate_limit' | null {
  try {
    const body = asRecord(JSON.parse(raw))
    const error = asRecord(body?.['error'])
    const code = error?.['code'] ?? body?.['code']
    const name = asStr(code)
    if (name === 'context_length_exceeded') return 'context_overflow'
    if (name && /rate.?limit/i.test(name)) return 'rate_limit'
    // Another typed cause (`insufficient_quota` also comes as a 429) is not one of these.
    if (name && name !== '429') return null
    const status = body?.['status'] ?? error?.['status']
    if (status === 429 || code === 429 || name === '429') return 'rate_limit'
    if (/rate.?limit/i.test(asStr(error?.['type']) ?? '')) return 'rate_limit'
  } catch {
    // Not JSON: the CLI's own sentence.
  }
  return isContextOverflowMessage(backendErrorText(raw)) ? 'context_overflow' : null
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

  // A failed turn: top-level `{ type:'error', message }`, then `{ type:'turn.failed',
  // error:{ message } }`. Kept for the close-synthesized terminal (codex exits non-zero).
  if (type === 'error' || type === 'turn.failed') {
    const raw = asStr(j['message']) ?? asStr(asRecord(j['error'])?.['message'])
    if (raw) {
      state.streamError = backendErrorText(raw)
      state.streamErrorCode = codexExecErrorCode(raw)
    }
    return []
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

/** Why a Codex run with agents on their own OS user has no credential. */
export const CODEX_AGENT_SIGN_IN_MESSAGE =
  'Sign in to Codex for the agents from the Runtimes page (agents run as their own user, ' +
  'so your own Codex login is not shared with them), or add an OpenAI API key.'

/**
 * Make the run's CODEX_HOME ready: the MANAGED (persistent, per-identity) home
 * when the caller resolved one from the adapter's integration plan, the legacy
 * throwaway mkdtemp otherwise. Seeds the user's `codex login` and writes the MCP
 * config. Throws (the run then fails with that message) when a managed home has
 * no usable credential, or any home does with agents on their own OS user.
 */
export async function prepareCodexHome(
  ctx: RuntimeRunContext,
): Promise<{ codexHome: string; managed: boolean }> {
  const managed = Boolean(ctx.homeDir)
  // The home is agent space: made and written through the agent-space file
  // verbs, which the agent host performs when agents run as their own OS user.
  const codexHome = ctx.homeDir ?? (await makeThrowawayRuntimeHome('clawboo-codex-home-'))
  if (managed) await agentMkdir(codexHome, { mode: 0o700 })
  const hasApiKey = Object.keys(ctx.apiKeyEnv ?? {}).length > 0
  const agentMode = isAgentUserMode()
  // Seed the user's ChatGPT-OAuth login so the run authenticates with their
  // `codex login` account. Freshness-aware for a managed home (see seedCodexAuth);
  // never writes back to ~/.codex. With agents on their own OS user a run with an
  // API key gets no login copied in at all: one less credential in agent space.
  if (!(agentMode && hasApiKey)) await seedCodexAuth(codexHome)
  // FAIL-FAST guard (managed homes only — the Paperclip codex-local pattern):
  // no usable provisioned credential + no API key env ⇒ an explicit error the
  // engine can reflect, never an unauthenticated request with a cryptic 401.
  // The throwaway path keeps its historic lenient behavior (codex surfaces its
  // own auth error), so nothing else changes shape. With agents on their own OS
  // user every run is guarded, and the message says why the person's own login
  // does not count.
  if ((managed || agentMode) && !hasApiKey && !(await hasUsableCodexAuthIn(codexHome))) {
    throw new Error(
      agentMode
        ? CODEX_AGENT_SIGN_IN_MESSAGE
        : `no Codex credentials provisioned for managed home ${codexHome} — ` +
            `run \`${terminalCommandName('codex')} login\` in your terminal, then retry`,
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
    // Owner-only: the URLs carry the run's signed attach scope.
    await agentWriteFile(
      path.join(codexHome, 'config.toml'),
      codexConfigToml(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined),
      { mode: 0o600 },
    )
  }
  return { codexHome, managed }
}

/** The Codex driver: app-server, falling back to `exec` (see the file header). */
export function createCodexDriver(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  deps: Partial<Pick<CodexAppServerDeps, 'command' | 'args' | 'handshakeTimeoutMs'>> = {},
): CodexDriver {
  return createCodexAppServerDriver(opts, ctx, {
    ...deps,
    prepareHome: () => prepareCodexHome(ctx),
    fallback: () => createCodexExecDriver(opts, ctx),
  })
}

/** One-shot `codex exec --json`: the fallback for a Codex without app-server. A
 *  run on it cannot be steered. */
export function createCodexExecDriver(opts: StartOpts, ctx: RuntimeRunContext): CodexDriver {
  const state: CodexRunState = {
    lastText: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    sawResult: false,
  }
  let modelPinned = false

  return createSpawnDriver<CodexNativeEvent>({
    async resolve() {
      const { codexHome, managed } = await prepareCodexHome(ctx)
      const prompt = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
      // No model unless the agent pins one: the CLI then runs the account's own
      // default, which the backend chooses, so it cannot go stale here.
      const model = ctx.model ?? opts.model
      modelPinned = Boolean(model)
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
      // synthesized so a second call returns [], never two
      // `result` terminals.
      state.sawResult = true
      // A deliberate abort kills the process with SIGTERM/SIGKILL (code null) —
      // surface it as a clean `aborted` terminal, not a spurious error.
      const aborted = signal === 'SIGTERM' || signal === 'SIGKILL'
      const ok = code === 0
      const reason =
        ok || aborted
          ? ''
          : codexFailureMessage({ streamError: state.streamError, stderr, code, modelPinned })
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
            : {
                errorMessage:
                  state.streamErrorCode === 'rate_limit' ? rateLimitMessage(reason) : reason,
                ...(state.streamErrorCode ? { errorCode: state.streamErrorCode } : {}),
              }),
        },
      ]
    },
  })
}
