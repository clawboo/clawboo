// Real Hermes driver — drives `hermes chat -q … -Q` headless. With a stable
// per-identity home (`ctx.homeDir`, materialized by the runner from the
// adapter's native-preservation capabilities) the runtime's native state —
// sessions, MEMORY.md, state.db, self-created skills — persists and COMPOUNDS
// across runs; without one (no runner, conservative default) it falls back to
// a throwaway home. The user's Hermes config is honored (no
// `--ignore-user-config`; the home is seeded once from ~/.hermes/config.yaml)
// and the provider comes from that config, with `--provider openrouter` only
// as the no-config fallback when an OpenRouter key is connected.
//
// Hermes is a single-task WORKER on clawboo's one board of record: clawboo does
// NOT sync Hermes's internal kanban — Hermes reaches the team's coordination
// surface by attaching clawboo's Tasks/Memory/Tools MCP (mcp.json in the home).
// It is dispatched ONLY via one-shot `hermes chat` — never `hermes gateway`
// (channels are Hermes-native and stay off for teammate dispatch).
//
// Hermes is non-streaming. Quiet mode (`-Q`) prints the final response on
// stdout and the `session_id: …` line on STDERR (live-verified against
// hermes-agent 0.15.2) — `onClose` scans stderr for it, and `parseHermesLine`
// ALSO tolerates the line (or a JSON frame carrying `session_id`) on stdout in
// case a future CLI moves it. The line is the single sanctioned structured-line
// capture: a machine-emitted contract line, not rendered-output scraping. No
// match simply means a fresh session next dispatch — never a failure. The
// terminal `result` is synthesized on process exit, the reliable path. (Argv
// shape per the preserved-runtime adapter.)

import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HermesDriver, HermesNativeEvent } from '@clawboo/adapter-hermes'
import { buildAttachConfig, MCP_SERVER_NAMES, type AttachScope } from '@clawboo/mcp'
import type { StartOpts } from '@clawboo/executor'

import { resolveRuntimeBin } from '../platform'
import { detectProvider, provisionHermesHome, type ProvisionedHermesHome } from './hermesHome'
import { createSpawnDriver, type ResolvedSpawn } from './subprocess'
import type { RuntimeRunContext } from './types'

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Quiet-mode session-info line. Base form `session_id: <id>`, widened to
 *  tolerate `Session ID:` / `session-id:` casing variants. */
export const HERMES_SESSION_LINE = /^\s*session[\s_-]?id\s*:\s*(\S+)\s*$/i

export function hermesMcpConfig(baseUrl: string, scope?: AttachScope): string {
  // JSON map of clawboo MCP servers for Hermes's MCP client to load from the
  // home. Exact filename/shape confirmed against the CLI in the live smoke. The
  // shared Memory server's URL carries the run's scope (see buildAttachConfig).
  const servers: Record<string, { url: string }> = {}
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
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

export interface HermesRunState {
  sessionId?: string
  lastText: string
  sawResult: boolean
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
  const text = `${line}\n`
  state.lastText += text
  return [{ type: 'message', text }]
}

/** Pure spawn-plan builder — argv/env/home assertions need no spawn mocks. */
export async function buildHermesSpawnPlan(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  home: ProvisionedHermesHome,
): Promise<ResolvedSpawn> {
  const prompt = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
  const model = ctx.model ?? opts.model
  // Provider precedence: the home config's `model.provider` wins (pass NO flag
  // — Hermes resolves it itself, including user-defined provider names) → an
  // OPENROUTER_API_KEY in the run env adds `--provider openrouter` as the
  // no-config compatibility fallback (a pasted OpenRouter key just works) →
  // otherwise nothing (Hermes default `auto`).
  const configuredProvider = await detectProvider(home.home)
  const openrouterFallback = !configuredProvider && Boolean(ctx.apiKeyEnv?.['OPENROUTER_API_KEY'])
  // Resume only into a PRE-EXISTING home — a freshly created one cannot hold
  // the prior session.
  const resume = !home.created && ctx.resume ? ctx.resume : null
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
    ...(openrouterFallback ? ['--provider', 'openrouter'] : []),
  ]
  // Resolve the absolute path — Hermes lives in the Python user-site bin
  // (e.g. ~/Library/Python/<ver>/bin), off the server's PATH, so a bare
  // `spawn('hermes')` would ENOENT. Also prepend its dir to PATH so any
  // tools Hermes itself shells out to are found.
  const hermesBin = resolveRuntimeBin('hermes')
  const binDir = hermesBin ? path.dirname(hermesBin) : null
  return {
    command: hermesBin ?? 'hermes',
    args,
    cwd: ctx.cwd ?? undefined,
    env: {
      HERMES_HOME: home.home,
      ...(binDir ? { PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` } : {}),
      ...(ctx.apiKeyEnv ?? {}),
    },
  }
}

export function createHermesDriver(opts: StartOpts, ctx: RuntimeRunContext): HermesDriver {
  const state: HermesRunState = { lastText: '', sawResult: false }

  return createSpawnDriver<HermesNativeEvent>({
    async resolve() {
      // Persistent per-identity home when the runner materialized one;
      // otherwise a throwaway home (the conservative one-shot default).
      const homeDir = ctx.homeDir ?? (await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-home-')))
      const home = await provisionHermesHome(homeDir, {
        mcpJson: ctx.mcpBaseUrl
          ? hermesMcpConfig(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined)
          : null,
      })
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
      return [
        {
          type: 'result',
          ok,
          ...(aborted ? { aborted: true } : {}),
          summary: stripSessionInfo(state.lastText) || stripSessionInfo(stdout),
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          ...(ok || aborted
            ? {}
            : { errorMessage: stderr.trim() || `hermes exited with code ${code}` }),
        },
      ]
    },
  })
}
