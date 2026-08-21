// Real Claude Code driver — wraps the Claude Agent SDK's `query()` (the
// recommended TS substrate: it reuses Claude Code's own loop/permissions and
// uses the logged-in CLI's auth, BYO-key as fallback). The SDK is imported
// LAZILY inside `run()` so the shipped server never requires it at boot — the
// default install carries no Claude Code dependency, and an install that lacks
// the SDK gets an actionable message, not a resolver error (see `loadAgentSdk`). The driver
// translates SDK messages → the adapter's `ClaudeNativeEvent` union; the pure
// `mapClaudeEvent` (in @clawboo/adapter-claude-code) turns those into the
// normalized RuntimeEvent stream. Claude Code reports a real `total_cost_usd`,
// passed straight through (not estimated).

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ClaudeCodeDriver, ClaudeNativeEvent } from '@clawboo/adapter-claude-code'
import { buildAttachConfig, MCP_SERVER_NAMES, type AttachScope } from '@clawboo/mcp'
import type { StartOpts } from '@clawboo/executor'

import { buildChildEnv } from './childEnv'
import type { RuntimeRunContext } from './types'

// Minimal structural shapes for the SDK objects we read — deliberately decoupled
// from the SDK's deep generated types (which reference a different zod major).
interface SdkContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  message?: { content?: unknown }
  result?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
  errors?: string[]
}
interface SdkModule {
  query(params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<SdkMessage>
}

/** The optional runtime dependency this driver needs — named once for the
 *  remediation message. The `import()` below keeps the literal so the bundler
 *  (and the clean-install externals check) can still see the edge. */
const AGENT_SDK = '@anthropic-ai/claude-agent-sdk'

/** The specifier Node names as unresolvable, read out of the resolver message.
 *  ESM: `Cannot find package 'x' imported from <importer>` · CJS: `Cannot find
 *  module 'x'`. Null when the message doesn't match that shape. */
function unresolvedSpecifierOf(message: string): string | null {
  return message.match(/Cannot find (?:package|module) '([^']+)'/)?.[1] ?? null
}

/** True when `err` is Node reporting that OUR specifier could not be resolved
 *  (not a missing transitive dep inside the SDK, which is a different problem
 *  and must not be reported as "install the SDK"). Exported for tests — the
 *  workspace always resolves the SDK, so the miss can't be provoked here.
 *
 *  The specifier is READ OUT of the message rather than searched for anywhere in
 *  it: the ESM resolver appends `imported from <importer>`, and when a
 *  transitive dependency OF the SDK is the missing one, that importer path sits
 *  inside the SDK's own package dir — so a substring test would confidently hand
 *  the user the wrong instruction. An unparseable message returns false; a raw
 *  resolver error beats a misleading remediation. */
export function isAgentSdkMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false
  if (!(err instanceof Error)) return false
  return unresolvedSpecifierOf(err.message) === AGENT_SDK
}

/**
 * Lazy-load the Claude Agent SDK.
 *
 * It is deliberately NOT a dependency of the published `clawboo` package: its
 * per-platform optional dependency is a ~210 MB `claude` binary and npm installs
 * optional dependencies by default, so declaring it would add that to EVERY
 * install for a runtime most users never touch (the clean-install gate treats it
 * as a documented optional external for the same reason). The cost is that a
 * packaged install has to be told once — so turn Node's bare `Cannot find
 * package` into the instruction that fixes it, instead of surfacing a resolver
 * error as the run's failure summary.
 */
async function loadAgentSdk(): Promise<SdkModule> {
  try {
    return (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SdkModule
  } catch (err) {
    if (!isAgentSdkMissing(err)) throw err
    throw new Error(
      `The Claude Code runtime needs ${AGENT_SDK}, which this clawboo install does not ship ` +
        '(it would add ~210 MB of platform binary to every install). Install it alongside ' +
        `clawboo — \`npm install -g ${AGENT_SDK}\` when clawboo itself is installed globally — ` +
        'then re-run the task. See https://docs.claw.boo/runtimes/claude-code',
    )
  }
}

function blocksOf(msg: SdkMessage): SdkContentBlock[] {
  const c = msg.message?.content
  return Array.isArray(c) ? (c as SdkContentBlock[]) : []
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .join('')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/** Translate one SDK message into zero+ native Claude events. */
export function translateClaudeMessage(msg: SdkMessage): ClaudeNativeEvent[] {
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' && msg.session_id
        ? [{ type: 'init', sessionId: msg.session_id, ...(msg.model ? { model: msg.model } : {}) }]
        : []
    case 'assistant': {
      const out: ClaudeNativeEvent[] = []
      for (const b of blocksOf(msg)) {
        if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking)
          out.push({ type: 'text', text: b.thinking, channel: 'reasoning' })
        else if (b.type === 'tool_use' && b.id && b.name)
          out.push({ type: 'tool-call', id: b.id, name: b.name, input: b.input })
      }
      return out
    }
    case 'user': {
      const out: ClaudeNativeEvent[] = []
      for (const b of blocksOf(msg)) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          out.push({
            type: 'tool-result',
            id: b.tool_use_id,
            name: '',
            output: stringifyToolContent(b.content),
            isError: b.is_error ?? false,
          })
        }
      }
      return out
    }
    case 'result': {
      const ok = msg.subtype === 'success'
      // The SDK signals a turn-ceiling stop as `result.subtype === 'error_max_turns'`.
      // Surface it distinctly so the host rotates the session (continue) instead of
      // failing the task.
      const maxTurns = msg.subtype === 'error_max_turns'
      const usage = msg.usage
        ? {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            ...(msg.usage.cache_read_input_tokens != null
              ? { cachedInputTokens: msg.usage.cache_read_input_tokens }
              : {}),
          }
        : undefined
      const errMsg = msg.errors?.join('; ') ?? msg.subtype
      return [
        {
          type: 'result',
          ok,
          summary: ok ? (msg.result ?? '') : (errMsg ?? 'error'),
          costUsd: msg.total_cost_usd ?? null,
          ...(usage ? { usage } : {}),
          ...(msg.session_id ? { sessionId: msg.session_id } : {}),
          ...(maxTurns ? { maxTurns: true } : {}),
          ...(ok ? {} : { errorMessage: errMsg }),
        },
      ]
    }
    default:
      return []
  }
}

function mcpServersFor(
  baseUrl: string,
  scope?: AttachScope,
): Record<string, { type: 'http'; url: string }> {
  const servers: Record<string, { type: 'http'; url: string }> = {}
  for (const server of MCP_SERVER_NAMES) {
    const cfg = buildAttachConfig({
      runtime: 'claude-code',
      server,
      transport: 'http',
      httpBaseUrl: baseUrl,
      scope,
    })
    Object.assign(servers, cfg.structured)
  }
  return servers
}

export function createClaudeCodeDriver(opts: StartOpts, ctx: RuntimeRunContext): ClaudeCodeDriver {
  const handlers = new Set<(ev: ClaudeNativeEvent) => void>()
  const buffered: ClaudeNativeEvent[] = []
  let subscribed = false
  let started = false
  const abort = new AbortController()

  const push = (ev: ClaudeNativeEvent): void => {
    if (!subscribed) {
      buffered.push(ev)
      return
    }
    for (const h of [...handlers]) h(ev)
  }

  async function run(): Promise<void> {
    try {
      const mod = await loadAgentSdk()
      const prompt = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
      const options: Record<string, unknown> = {
        abortController: abort,
        // Headless worker: clawboo gates risky tools externally (board/approvals)
        // and the run is confined to an isolated per-task worktree. The SDK
        // requires the explicit opt-in alongside bypassPermissions.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }
      const model = ctx.model ?? opts.model
      if (ctx.cwd) options['cwd'] = ctx.cwd
      if (model) options['model'] = model
      if (ctx.resume) options['resume'] = ctx.resume
      if (ctx.mcpBaseUrl)
        options['mcpServers'] = mcpServersFor(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined)
      if (opts.childToolBlocklist?.length) options['disallowedTools'] = opts.childToolBlocklist
      // Always hand the SDK subprocess a scrubbed env: clawboo's own server secrets
      // (gateway/access-control token, vault master key) are stripped, while the
      // connected provider key (e.g. ANTHROPIC_API_KEY from the encrypted vault) is
      // merged in so API-key auth is deterministic. The spawned CLI keeps PATH / HOME /
      // etc. When the key is absent (Keychain/OAuth user), apiKeyEnv is empty and the
      // SDK falls back to the logged-in CLI's own auth (not env-based).
      options['env'] = buildChildEnv(ctx.apiKeyEnv ?? {})
      for await (const msg of mod.query({ prompt, options })) {
        for (const ev of translateClaudeMessage(msg)) push(ev)
      }
    } catch (err) {
      // An abort WE asked for is not a failure. The SDK rejects its iterator when
      // the signal fires, so without this check a deliberate stop (the user's Stop
      // button, the budget cap, the drain's wedge guard) is reported as a crash:
      // the badge reads error and the team chat posts a "The run failed" notice
      // blaming the user for the thing they just did. The native, codex and hermes
      // drivers all make this distinction already; this one is the odd one out.
      if (abort.signal.aborted) {
        push({ type: 'result', ok: true, aborted: true, summary: '' })
        return
      }
      push({
        type: 'result',
        ok: false,
        summary: '',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      void run()
    },
    onEvent(handler: (ev: ClaudeNativeEvent) => void): () => void {
      handlers.add(handler)
      if (!subscribed) {
        subscribed = true
        const pending = buffered.splice(0)
        for (const ev of pending) handler(ev)
      }
      return () => handlers.delete(handler)
    },
    async abort(): Promise<void> {
      abort.abort()
    },
    async setModel(): Promise<void> {
      // The SDK fixes the model at query() time — no mid-run switch.
    },
    async writeContext(key: string, value: string): Promise<void> {
      if (!ctx.cwd) return
      const target = path.join(ctx.cwd, key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, value, 'utf8')
    },
  }
}
