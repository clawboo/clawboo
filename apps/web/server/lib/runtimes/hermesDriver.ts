// Real Hermes driver — drives `hermes chat -q … -Q` headless. With a stable
// per-identity home (`ctx.homeDir`, materialized by the runner from the
// adapter's native-preservation capabilities) the runtime's native state —
// sessions, MEMORY.md, state.db, self-created skills — persists and COMPOUNDS
// across runs; without one (no runner, conservative default) it falls back to
// a throwaway home. The user's Hermes config is honored (no
// `--ignore-user-config`; the home is seeded once from ~/.hermes/config.yaml)
// and the provider comes from that config; with no config we derive `--provider`
// from whichever connected key is present (OpenRouter -> `openrouter`, a reused
// native Anthropic key -> `anthropic`, OpenAI -> `openai-api`), so a single
// onboarding key drives Hermes without a second prompt.
//
// Hermes is a single-task WORKER on clawboo's one board of record: clawboo does
// NOT sync Hermes's internal kanban — Hermes reaches the team's coordination
// surface by attaching clawboo's Tasks/Memory/Tools/TeamChat MCP servers (the
// clawboo-owned `mcp_servers` block of the home's config.yaml).
// It is dispatched ONLY via one-shot `hermes chat` — never `hermes gateway`
// (channels are Hermes-native and stay off for teammate dispatch).
//
// Hermes is non-streaming, so while the process runs the driver emits a
// `status: running` beat every HERMES_HEARTBEAT_MS. Every idle watchdog counts
// any event as activity (the delegation sweep, the board drain's silence
// guard), so a long Hermes run is not killed for printing nothing until exit.
// The beat proves the process is alive, not that it is progressing, so it
// stops after HERMES_HEARTBEAT_MAX_MS and a hung run meets the silence limits.
//
// Quiet mode (`-Q`) prints the final response on
// stdout and the `session_id: …` line on STDERR (live-verified against
// hermes-agent 0.15.2) — `onClose` scans stderr for it, and `parseHermesLine`
// ALSO tolerates the line (or a JSON frame carrying `session_id`) on stdout in
// case a future CLI moves it. The line is the single sanctioned structured-line
// capture: a machine-emitted contract line, not rendered-output scraping. No
// match simply means a fresh session next dispatch — never a failure. The
// terminal `result` is synthesized on process exit, the reliable path. (Argv
// shape per the preserved-runtime adapter.)
//
// STEERING is interrupt-and-resume, because one-shot `hermes chat -q` takes no
// input once started (its live `/steer` exists only in `hermes acp`). `steer()`
// stops the process and resumes the SAME session in the SAME home with the steer
// as the next input, all inside this one run (`createSpawnDriver.relaunch`): the
// stopped process's exit is absorbed, so the host never sees an aborted terminal
// and nothing reads the stop as a failure or a Stop. Verified against hermes-agent
// 0.15.2: a SIGTERM'd `-q` run is interrupted gracefully, its session was created
// at start and its messages persisted after each tool batch, but it prints no
// session line, so a run whose id is not already known resumes with `--continue`
// (the newest session in this home, which under the per-identity home mutex is
// the stopped run). The tool call in flight at the stop is lost; the run is not.

import path from 'node:path'

import type { HermesDriver, HermesNativeEvent } from '@clawboo/adapter-hermes'
import { buildAttachConfig, MCP_SERVER_NAMES, type AttachScope } from '@clawboo/mcp'
import type { StartOpts } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'

import { resolveRuntimeBin } from '../platform'
import { isContextOverflowMessage } from './native/providers/types'
import {
  detectProvider,
  provisionHermesHome,
  type HermesMcpServers,
  type ProvisionedHermesHome,
} from './hermesHome'
import {
  hasUsableHermesCodexAuth,
  hasUsableHermesCodexAuthIn,
  userHermesAuthPath,
} from './hermesAuth'
import { isAgentUserMode } from '../agentUser/config'
import { makeThrowawayRuntimeHome } from './identityHome'
import { createSpawnDriver, type ResolvedSpawn } from './subprocess'
import type { RuntimeRunContext } from './types'

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const log = createLogger('hermes-driver')

/** How often a running Hermes process reports that it is still alive. Well
 *  under the shortest idle watchdog (the 8-minute delegation sweep). */
export const HERMES_HEARTBEAT_MS = 60_000
/** How long it keeps reporting. Past this a run that still prints nothing is
 *  left to the silence limits, so a hung process cannot run forever. */
export const HERMES_HEARTBEAT_MAX_MS = 2 * 60 * 60_000

/** Quiet-mode session-info line. Base form `session_id: <id>`, widened to
 *  tolerate `Session ID:` / `session-id:` casing variants. */
export const HERMES_SESSION_LINE = /^\s*session[\s_-]?id\s*:\s*(\S+)\s*$/i

/** Where a provider's error body starts in Hermes's output: its `error` object,
 *  printed as a Python dict or as JSON. */
const ERROR_BODY_RE = /['"]error['"]\s*:\s*\{/
/** A string-valued `code` or `type` field in that body. */
const ERROR_FIELD_RE = /['"](code|type)['"]\s*:\s*['"]([A-Za-z][\w.-]*)['"]/g
/** A string-valued `message` field, in a Python dict's quoting or JSON's. */
const ERROR_MESSAGE_RE = /['"]message['"]\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/
/** The HTTP status in front of an error body, or a number where a `code` goes. */
const ERROR_STATUS_RE = /error code:\s*(\d{3})\D*$/i
const ERROR_NUMERIC_CODE_RE = /['"]code['"]\s*:\s*(\d{3})\b/
/** A provider's own code for a prompt over the model's context window. */
const CONTEXT_CODE_RE = /^context[_-]?(?:length|window)[_-]?exceeded$/i
/** A provider's catch-all for a refused request: says nothing about the cause. */
const GENERIC_REFUSAL_RE = /^(?:invalid_request(?:_error)?|bad_?request(?:_?error)?)$/i
/**
 * What Hermes itself says when it gives up on a context overflow, having already
 * tried to compress the conversation or been told not to (agent/conversation_loop.py,
 * 0.15.2 to 0.19.0). A quiet run prints its error as its response on stdout; ACP's
 * stderr has the `❌` and `[ERROR]` lines. Its status lines while it still works on it
 * do not match, and neither do its words for a request body too big to send ("Request
 * payload too large", "reached for payload-too-large error"): that is a size limit on
 * the request, not the model's context window.
 */
const HERMES_GAVE_UP_RE =
  /context length exceeded\b[^\n]*(?:cannot compress further|max compression attempts)|context overflow and auto-compaction is disabled|❌[^\n]*max compression attempts \(\d+\) reached\.|context compression failed after \d+ attempts/i

/** Lines of Hermes's output that state why a run failed. */
export const HERMES_ERROR_LINE_RE = /❌|\[ERROR\]|Error code:|\bError:/

/** Whether a printed line holding a provider's error body says the prompt was over the
 *  model's context window. A rate-limit status, or a specific cause of any other kind,
 *  is not an overflow. */
function bodySaysOverflow(line: string): boolean {
  const start = line.search(ERROR_BODY_RE)
  if (start < 0) return false
  const body = line.slice(start)
  const named = [...body.matchAll(ERROR_FIELD_RE)]
  const code = named.find(([, field]) => field === 'code')?.[2]
  if (code && CONTEXT_CODE_RE.test(code)) return true
  const status =
    ERROR_STATUS_RE.exec(line.slice(0, start))?.[1] ?? ERROR_NUMERIC_CODE_RE.exec(body)?.[1]
  if (status && !['400', '413', '422'].includes(status)) return false
  const cause = code ?? named.find(([, field, v]) => field === 'type' && v !== 'error')?.[2]
  if (cause && !GENERIC_REFUSAL_RE.test(cause)) return false
  const message = ERROR_MESSAGE_RE.exec(body)
  return isContextOverflowMessage(message?.[1] ?? message?.[2] ?? '')
}

/** A line a sub-agent printed (`log_prefix` in tools/delegate_tool.py). That is its own
 *  run, which the parent may well outlive, so it never speaks for the parent's. */
const SUBAGENT_LINE_RE = /\[subagent-\d+\]/
/** A log line below error level. Hermes logs each refused attempt this way, whether or
 *  not it goes on to recover, so such a line never says why a run ended. */
const LOW_LEVEL_LOG_RE = /\[(?:DEBUG|INFO|WARNING)\]/

/** The lines of a run's output that can speak for how that run ended. */
function ownLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !SUBAGENT_LINE_RE.test(l) && !LOW_LEVEL_LOG_RE.test(l))
}

/** Whether a line says the run's prompt was over the model's context window. */
function isOverflowLine(line: string): boolean {
  if (HERMES_GAVE_UP_RE.test(line)) return true
  return ERROR_BODY_RE.test(line) ? bodySaysOverflow(line) : isContextOverflowMessage(line)
}

/** Whether a failed Hermes run ended on the model's context window: the last error it
 *  printed of its own is Hermes giving up, or a provider's body saying so. */
function endedOnContextOverflow(text: string): boolean {
  const own = ownLines(text).filter((l) => l.trim())
  const errors = own.filter(
    (l) => HERMES_ERROR_LINE_RE.test(l) || HERMES_GAVE_UP_RE.test(l) || ERROR_BODY_RE.test(l),
  )
  const last = errors.at(-1) ?? own.at(-1) ?? ''
  return HERMES_GAVE_UP_RE.test(last) || bodySaysOverflow(last)
}

/** A run's own output with every statement about an overflow taken out, for a turn that
 *  cannot have ended on one: Hermes gives up by answering the turn. */
export function withoutOverflowLines(text: string): string {
  return ownLines(text)
    .filter((l) => !isOverflowLine(l))
    .join('\n')
}

/**
 * A failed run's own output, without what it logged about an overflow it got past. When
 * the run ended some other way those lines are not why it failed. Left in, they read as
 * its cause: to the error classes, and in the sentence a person is shown.
 */
export function withoutRecoveredOverflow(text: string): string {
  const own = ownLines(text)
  if (endedOnContextOverflow(text)) return own.join('\n')
  const kept = own.filter((l) => !isOverflowLine(l))
  return (kept.some((l) => l.trim()) ? kept : own).join('\n')
}

/**
 * The cause of a failed Hermes run, or null. `context_overflow` when it ended on the
 * model's context window, the code every runtime uses for that. Otherwise the cause a
 * provider named in the last error body Hermes printed, which is the one the run ended
 * on. The OpenAI style puts the specific cause in `code` (`invalid_api_key`,
 * `insufficient_quota`) under a broader `type`; the Anthropic style has only `type`
 * (`authentication_error`). Only the error object is read, so other JSON on the same
 * output cannot pose as the cause.
 */
export function hermesErrorCode(text: string): string | null {
  if (endedOnContextOverflow(text)) return 'context_overflow'
  const remaining = withoutRecoveredOverflow(text)
  // The first body on the last line that has one: a provider's body can nest another.
  let start = -1
  let offset = 0
  for (const line of remaining.split('\n')) {
    const at = line.search(ERROR_BODY_RE)
    if (at >= 0) start = offset + at
    offset += line.length + 1
  }
  if (start < 0) return null
  let type: string | null = null
  for (const [, field, value] of remaining.slice(start).matchAll(ERROR_FIELD_RE)) {
    if (field === 'code') return value!
    if (!type && value !== 'error') type = value!
  }
  return type
}

/** A failed run's message, with the provider's typed cause when it named one. */
function failureOf(message: string): { errorMessage: string; errorCode?: string } {
  const errorCode = hermesErrorCode(message)
  return {
    errorMessage: withoutRecoveredOverflow(message).trim() || message,
    ...(errorCode ? { errorCode } : {}),
  }
}

/** A startup warning Hermes prints before any reply ("⚠ tirith security scanner enabled
 *  but not available ..."). It says nothing about how the run ended. */
const HERMES_BANNER_RE = /^\s*⚠/u

/**
 * What a quiet run prints on stdout in place of a reply when it failed: its error IS
 * its final response (agent/conversation_loop.py, 0.19.0). Anything else on stdout is the
 * model's own words, which may mention a 401 or a quota, and is never read as the cause.
 */
const HERMES_ERROR_REPLY_RE =
  /^(?:Context length exceeded\b|Context overflow and auto-compaction is disabled|Request payload too large|API call failed after \d+ retries:|Invalid API response after \d+ retries:|Billing or credits exhausted:|Model generated invalid tool call:|HTTP \d{3}:)/i

/** A provider's refusal given as the reply, when Hermes did not read it as an overflow
 *  itself: `HTTP 400: This model's maximum context length ...`. */
const HERMES_REFUSAL_REPLY_RE = /^HTTP (?:400|413|422):/

/**
 * Why a quiet `hermes chat -Q` run failed, given what it printed on both streams. When
 * its error is its reply (stderr then normally holds only the session line), that is
 * the reason, and a stray line on stderr cannot hide it. The cause is read from stderr
 * and that reply together. With no such reply, the reason is stderr, then the exit code.
 */
export function hermesQuietFailure(output: {
  stdout: string
  stderr: string
  code: number | null
}): { errorMessage: string; errorCode?: string } {
  const lines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .filter((l) => l.trim() && !HERMES_SESSION_LINE.test(l) && !HERMES_BANNER_RE.test(l))
      .map((l) => l.trim())
  const stderr = lines(output.stderr).join('\n')
  const lastOut = lines(output.stdout).at(-1) ?? ''
  if (!HERMES_ERROR_REPLY_RE.test(lastOut)) {
    return failureOf(stderr || `hermes exited with code ${output.code}`)
  }
  const isOverflow =
    endedOnContextOverflow(lastOut) ||
    (HERMES_REFUSAL_REPLY_RE.test(lastOut) && isContextOverflowMessage(lastOut))
  const errorCode = isOverflow
    ? 'context_overflow'
    : hermesErrorCode([stderr, lastOut].filter(Boolean).join('\n'))
  return { errorMessage: lastOut, ...(errorCode ? { errorCode } : {}) }
}

/** The clawboo MCP servers for a Hermes run, written into the home's
 *  config.yaml by provisionHermesHome. The shared Memory server's URL carries
 *  the run's scope (see buildAttachConfig). */
export function hermesMcpServers(baseUrl: string, scope?: AttachScope): HermesMcpServers {
  const servers: HermesMcpServers = {}
  for (const server of MCP_SERVER_NAMES) {
    const cfg = buildAttachConfig({
      runtime: 'openclaw',
      server,
      transport: 'http',
      httpBaseUrl: baseUrl,
      scope,
    })
    servers[`clawboo-${server}`] = { url: (cfg.structured as { url: string }).url }
  }
  return servers
}

export interface HermesRunState {
  sessionId?: string
  lastText: string
  sawResult: boolean
}

/** The security scanner's startup warning, printed before the reply. Only this one, and
 *  only before the reply starts: any other line, even one that warns about tirith, is the
 *  model's own words. */
const HERMES_TIRITH_BANNER_RE = /^\s*⚠\uFE0F?\s*tirith security scanner enabled\b/iu

/** Everything a run printed on stdout from its first line that is not its startup warning. */
export function withoutStartupBanner(stdout: string): string {
  const lines = stdout.split('\n')
  const start = lines.findIndex(
    (l) => l.trim() && !HERMES_TIRITH_BANNER_RE.test(l) && !HERMES_SESSION_LINE.test(l),
  )
  return start === -1 ? '' : lines.slice(start).join('\n')
}

/** Recognized JSON frame → native events; null when the JSON is not a frame
 *  (a JSON-shaped response line then passes through as plain text). */
function translateJsonFrame(raw: unknown, state: HermesRunState): HermesNativeEvent[] | null {
  const j = asRecord(raw)
  if (!j) return null
  const sid = asStr(j['session_id']) ?? asStr(j['sessionId'])
  if (sid) {
    if (state.sessionId) return [] // duplicate session frame — already captured
    state.sessionId = sid
    return [
      {
        type: 'session',
        sessionId: sid,
        ...(asStr(j['model']) ? { model: asStr(j['model']) } : {}),
      },
    ]
  }
  const type = asStr(j['type']) ?? ''
  if (type.includes('message') || type.includes('assistant')) {
    const text = asStr(j['text']) ?? asStr(j['content']) ?? asStr(j['message'])
    if (text) {
      state.lastText += text
      return [{ type: 'message', text }]
    }
  }
  return null
}

/** Pure line parser (exported for tests): JSON frame → session-info line →
 *  plain response text (accumulated into the run summary). */
export function parseHermesLine(line: string, state: HermesRunState): HermesNativeEvent[] {
  let raw: unknown
  let isJson = false
  try {
    raw = JSON.parse(line)
    isJson = true
  } catch {
    // not JSON — fall through to the line forms
  }
  if (isJson) {
    const frame = translateJsonFrame(raw, state)
    if (frame) return frame
  }
  const m = HERMES_SESSION_LINE.exec(line)
  if (m?.[1]) {
    if (state.sessionId) return []
    state.sessionId = m[1]
    return [{ type: 'session', sessionId: m[1] }]
  }
  if (!state.lastText && HERMES_TIRITH_BANNER_RE.test(line)) return []
  const text = `${line}\n`
  state.lastText += text
  return [{ type: 'message', text }]
}

/** Fallback model per DERIVED provider (used only when no explicit model and no
 *  config.yaml model is set): a provider such as OpenRouter returns 400
 *  "No models provided" when the request carries no model, and a coding-runtime
 *  team member is model-inert (ctx.model is null). The ids are cheap,
 *  always-available choices in each provider's own namespace.
 *
 *  `openai-codex` (the ChatGPT subscription) is deliberately absent: given no
 *  `-m`, Hermes asks the backend which models the account may use and runs the
 *  first, so no id is passed that the backend could later refuse ("The '<model>'
 *  model is not supported when using Codex with a ChatGPT account"). */
const DERIVED_PROVIDER_MODEL: Record<string, string> = {
  openrouter: 'openai/gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  'openai-api': 'gpt-4o-mini',
}

/** Per-provider vault env-var — used to check a PICKED provider is actually connected
 *  before pinning it. A pick whose key isn't present degrades to the key-derived
 *  default instead of hard-failing ("No <provider> credentials found"). A provider not
 *  in the map (e.g. a keyless/ollama-style one) is treated as usable. */
const PICK_PROVIDER_ENV: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-api': 'OPENAI_API_KEY',
}

/** What a Hermes run starts with, whichever way it is driven (`chat -Q` or `acp`):
 *  its prompt, the model and provider it is pinned to, the session it resumes,
 *  and the command and environment of the process. */
export interface HermesRunSettings {
  prompt: string
  /** The model to pin, or undefined to leave it to the home config. */
  model: string | undefined
  /** The provider to pin, or null to leave it to the home config or Hermes. */
  providerFlag: string | null
  /** A provider the agent was set to and has a key for: it beats the home config. */
  pickedProvider: string | null
  /** The session to resume, only ever in a home that already existed. */
  resume: string | null
  command: string
  env: Record<string, string>
}

/** Why a Hermes subscription run with agents on their own OS user has no credential. */
export const HERMES_AGENT_SIGN_IN_MESSAGE =
  'Sign in to Hermes for the agents from the Runtimes page (agents run as their own user, ' +
  'so your own Hermes login is not shared with them), or add an API key for a Hermes provider.'

/** Pure run-settings resolver, shared by both drivers. */
export async function resolveHermesRun(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  home: ProvisionedHermesHome,
): Promise<HermesRunSettings> {
  const prompt = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
  const explicitModel = ctx.model ?? opts.model
  // A per-agent PICKED provider (the create-team model picker, stored in execConfig →
  // ctx.providerHint) PINS Hermes to that provider so the picked model runs on it —
  // ahead of the home config + the key-derived default below. BUT a pick whose provider
  // key isn't connected is UNUSABLE: dropping the pin AND its provider-specific model,
  // then falling back to the key-derived provider + default, degrades a mismatched pick
  // gracefully instead of hard-failing "No <provider> credentials found" (e.g. an
  // Anthropic-direct pick on an OpenRouter-only setup).
  const requestedProvider = ctx.providerHint ?? null
  // `openai-codex` (the ChatGPT subscription) is OAuth, not an env-var key: its
  // usability is auth-file PRESENCE — the managed home's seeded auth.json (what
  // the run actually reads), falling back to the user's real ~/.hermes store
  // (first-provision timing). An EXPLICIT rule, not the unmapped-provider pass
  // below, so an auth-less subscription pick degrades exactly like a keyless
  // key-provider pick instead of hard-failing "codex_auth_missing".
  // The managed home is agent space, so its store is read through the agent-space
  // file verbs; the person's own store is the server's. Read once, on first need.
  // With agents on their own OS user the person's own login is never shared with
  // the agents, so only the home's counts.
  const agentMode = isAgentUserMode()
  let codexUsable: boolean | null = null
  const hermesCodexUsable = async (): Promise<boolean> => {
    codexUsable ??=
      (await hasUsableHermesCodexAuthIn(home.home)) ||
      (!agentMode && hasUsableHermesCodexAuth(userHermesAuthPath()))
    return codexUsable
  }
  const pickUsable =
    requestedProvider != null &&
    (requestedProvider === 'openai-codex'
      ? await hermesCodexUsable()
      : PICK_PROVIDER_ENV[requestedProvider] == null ||
        !!ctx.apiKeyEnv?.[PICK_PROVIDER_ENV[requestedProvider]!])
  const pickedProvider = pickUsable ? requestedProvider : null
  // A dropped (unusable) pick also drops its provider-specific model.
  const effectiveModel = requestedProvider != null && !pickUsable ? undefined : explicitModel
  // Provider precedence: the home config's `model.provider` wins (pass NO flag
  // — Hermes resolves it itself, including user-defined provider names) → else
  // derive the flag from whichever connected key is present. OpenRouter stays
  // FIRST (the default, always available with hermes core), then the direct
  // providers a reused native key maps to. The flag values are the exact hermes
  // provider ids (verified against the CLI's PROVIDER_REGISTRY): `openrouter`,
  // `anthropic` (reads ANTHROPIC_API_KEY, needs the `[anthropic]` extra which
  // the install bundles), and `openai-api` (reads OPENAI_API_KEY — `openai`
  // alone is NOT a valid provider id). Otherwise nothing (Hermes default `auto`).
  const configuredProvider = await detectProvider(home.home)
  const providerFlag = pickedProvider
    ? pickedProvider
    : configuredProvider
      ? null
      : ctx.apiKeyEnv?.['OPENROUTER_API_KEY']
        ? 'openrouter'
        : ctx.apiKeyEnv?.['ANTHROPIC_API_KEY']
          ? 'anthropic'
          : ctx.apiKeyEnv?.['OPENAI_API_KEY']
            ? 'openai-api'
            : // Last rung before hermes `auto`: the ChatGPT subscription. Keyed
              // on seeded-auth presence, AFTER every key rung so existing keyed
              // setups keep today's exact behavior.
              (await hermesCodexUsable())
              ? 'openai-codex'
              : null
  // With agents on their own OS user, a run that needs the subscription and has
  // neither the agents' own sign-in nor a provider key fails here with a message
  // that says why, rather than on Hermes's own missing-credential error.
  if (agentMode && !(await hermesCodexUsable())) {
    const keyed =
      Object.keys(ctx.apiKeyEnv ?? {}).length > 0 ||
      Object.values(PICK_PROVIDER_ENV).some((name) => Boolean(process.env[name]))
    const wantsSubscription =
      requestedProvider === 'openai-codex' ||
      configuredProvider === 'openai-codex' ||
      (!providerFlag && !configuredProvider)
    if (!keyed && wantsSubscription) throw new Error(HERMES_AGENT_SIGN_IN_MESSAGE)
  }
  // Resume only into a PRE-EXISTING home — a freshly created one cannot hold
  // the prior session.
  const resume = !home.created && ctx.resume ? ctx.resume : null
  // A DERIVED provider needs an explicit model: OpenRouter (and some others) 400
  // "No models provided" without one, and a coding-runtime team member is
  // model-inert (ctx.model is null). Fall back to a cheap per-provider default so
  // the run succeeds; an explicit ctx/opts model, or a model in the home's
  // config.yaml (the configuredProvider path, which passes NO -m), still wins.
  const model =
    effectiveModel ??
    (providerFlag && (pickedProvider || !configuredProvider)
      ? DERIVED_PROVIDER_MODEL[providerFlag]
      : undefined)
  // Resolve the absolute path: Hermes lives in the Python user-site bin
  // (e.g. ~/Library/Python/<ver>/bin), off the server's PATH, so a bare
  // `spawn('hermes')` would ENOENT. Also prepend its dir to PATH so any
  // tools Hermes itself shells out to are found.
  const hermesBin = resolveRuntimeBin('hermes')
  const binDir = hermesBin ? path.dirname(hermesBin) : null
  return {
    prompt,
    model,
    providerFlag,
    pickedProvider,
    resume,
    command: hermesBin ?? 'hermes',
    env: {
      HERMES_HOME: home.home,
      ...(binDir ? { PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` } : {}),
      ...(ctx.apiKeyEnv ?? {}),
    },
  }
}

/** Pure spawn-plan builder: argv/env/home assertions need no spawn mocks. */
export async function buildHermesSpawnPlan(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  home: ProvisionedHermesHome,
  /** `continueLatest`: resume the most recent session in this home
   *  (`--continue`) when no session id is known. Used to resume a run that was
   *  stopped to take a steer: one-shot `-Q` prints its session id only at a
   *  clean exit, and the stopped run is the newest session in its home. */
  extra: { continueLatest?: boolean } = {},
): Promise<ResolvedSpawn> {
  const { prompt, model, providerFlag, resume, command, env } = await resolveHermesRun(
    opts,
    ctx,
    home,
  )
  const args = [
    'chat',
    '-q',
    prompt,
    // Quiet: final response + session info only (the session-id source).
    '-Q',
    // Headless auto-approve; the worktree is the isolation boundary.
    '--yolo',
    // A seeded config may declare shell hooks; there is no TTY to approve them.
    '--accept-hooks',
    ...(model ? ['-m', model] : []),
    ...(resume ? ['--resume', resume] : []),
    ...(providerFlag ? ['--provider', providerFlag] : []),
    // Last: its session name is optional, so nothing may follow it as a value.
    ...(!resume && extra.continueLatest && !home.created ? ['--continue'] : []),
  ]
  return { command, args, cwd: ctx.cwd ?? undefined, env }
}

/** The input a stopped run resumes with: the steer(s), then why it stopped. */
export function hermesSteerPrompt(texts: string[]): string {
  return [
    ...texts,
    'Your run was paused so you could read this. Carry on with the task from where you left off, taking it into account.',
  ].join('\n\n')
}

export function createHermesDriver(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  deps: { heartbeatMs?: number; heartbeatMaxMs?: number } = {},
): HermesDriver {
  const state: HermesRunState = { lastText: '', sawResult: false }
  /** The home the run started in: a resume must land in the same one. */
  let homeDir: string | null = null
  /** Steers waiting for the next relaunch, and the promise that settles them. */
  let batch: { texts: string[]; result: Promise<boolean> } | null = null
  /** Relaunches run one after another. */
  let chain: Promise<unknown> = Promise.resolve()

  const spawn = createSpawnDriver<HermesNativeEvent>({
    heartbeat: {
      everyMs: deps.heartbeatMs ?? HERMES_HEARTBEAT_MS,
      maxMs: deps.heartbeatMaxMs ?? HERMES_HEARTBEAT_MAX_MS,
      event: () => ({ type: 'status', phase: 'running' }),
    },
    async resolve() {
      // Persistent per-identity home when the runner materialized one;
      // otherwise a throwaway home (the conservative one-shot default).
      homeDir = ctx.homeDir ?? (await makeThrowawayRuntimeHome('clawboo-hermes-home-'))
      const home = await provisionHermesHome(homeDir, {
        mcpServers: ctx.mcpBaseUrl
          ? hermesMcpServers(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined)
          : null,
        hasApiKey: Object.keys(ctx.apiKeyEnv ?? {}).length > 0,
        providerHint: ctx.providerHint ?? null,
      })
      if (ctx.mcpBaseUrl && !home.mcpAttached) {
        // The seeded config declares `mcp_servers` on one line with servers in it,
        // which a line edit cannot extend: this run has none of clawboo's tools.
        log.warn(
          { home: homeDir },
          "Hermes config.yaml has a one-line mcp_servers mapping; clawboo's MCP servers were not attached",
        )
      }
      return buildHermesSpawnPlan(opts, ctx, home)
    },
    parseLine(line: string): HermesNativeEvent[] {
      return parseHermesLine(line, state)
    },
    onClose(code, signal, stdout, stderr): HermesNativeEvent[] {
      if (state.sawResult) return []
      state.sawResult = true
      // PRIMARY capture: hermes -Q emits the session line on stderr
      // (live-verified); the stdout parse above is the shape tolerance.
      if (!state.sessionId) {
        for (const line of stderr.split('\n')) {
          const m = HERMES_SESSION_LINE.exec(line)
          if (m?.[1]) {
            state.sessionId = m[1]
            break
          }
        }
      }
      const stripSessionInfo = (s: string): string =>
        s
          .split('\n')
          .filter((l) => !HERMES_SESSION_LINE.test(l))
          .join('\n')
          .trim()
      // A deliberate abort kills the process with SIGTERM/SIGKILL (code null) —
      // surface it as a clean `aborted` terminal, not a spurious error.
      const aborted = signal === 'SIGTERM' || signal === 'SIGKILL'
      const ok = code === 0
      const summary =
        stripSessionInfo(state.lastText) || stripSessionInfo(withoutStartupBanner(stdout))
      return [
        {
          type: 'result',
          ok,
          ...(aborted ? { aborted: true } : {}),
          summary,
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          ...(ok || aborted
            ? {}
            : hermesQuietFailure({ stdout: state.lastText || stdout, stderr, code })),
        },
      ]
    },
  })

  /** The resumed process: same home, same flags, the steers as its input. A
   *  session id the run already knows (a resumed session keeps its id) is resumed
   *  by id; otherwise the newest session in the home, which is the stopped run. */
  async function resumePlan(texts: string[]): Promise<ResolvedSpawn> {
    if (!homeDir) throw new Error('hermes run has no home to resume in')
    const known = state.sessionId ?? ctx.resume ?? null
    // The stopped process printed nothing worth keeping (-Q prints at the end).
    state.lastText = ''
    return buildHermesSpawnPlan(
      { ...opts, context: null, message: hermesSteerPrompt(texts) },
      { ...ctx, resume: known },
      { home: homeDir, created: false, seededConfig: false, seededAuth: false },
      { continueLatest: known === null },
    )
  }

  return {
    ...spawn,
    // The one-shot path takes a steer by stopping the run and resuming it.
    steering: () => 'interrupt-resume' as const,
    steer(text: string): Promise<boolean> {
      if (state.sawResult) return Promise.resolve(false)
      // A steer that arrives before the queued relaunch starts rides along with it.
      if (batch) {
        batch.texts.push(text)
        return batch.result
      }
      const mine: { texts: string[]; result: Promise<boolean> } = {
        texts: [text],
        result: Promise.resolve(false),
      }
      mine.result = chain.then(async () => {
        // From here on, a new steer forms the next batch.
        if (batch === mine) batch = null
        if (state.sawResult) return false
        return spawn.relaunch(() => resumePlan(mine.texts))
      })
      batch = mine
      chain = mine.result.catch(() => false)
      return mine.result
    },
  }
}
