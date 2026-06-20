// Real Claude Code driver — wraps the Claude Agent SDK's `query()` (the
// recommended TS substrate: it reuses Claude Code's own loop/permissions and
// uses the logged-in CLI's auth, BYO-key as fallback). The SDK is imported
// LAZILY inside `run()` so the shipped server never requires it at boot — the
// default install carries no Claude Code dependency. The driver
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
      const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SdkModule
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
