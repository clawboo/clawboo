import { GatewayResponseError } from './errors'
import type {
  Frame,
  AutoRetryDelayParams,
  SessionPatchResult,
  SyncSessionSettingsParams,
} from './types'

// ─── Frame parsing ────────────────────────────────────────────────────────────

export const parseGatewayFrame = (raw: string): Frame | null => {
  try {
    return JSON.parse(raw) as Frame
  } catch {
    return null
  }
}

// ─── Session key helpers ──────────────────────────────────────────────────────

export const buildAgentMainSessionKey = (agentId: string, mainKey: string): string => {
  const trimmedAgent = agentId.trim()
  const trimmedKey = mainKey.trim() || 'main'
  return `agent:${trimmedAgent}:${trimmedKey}`
}

export const parseAgentIdFromSessionKey = (sessionKey: string): string | null => {
  const match = sessionKey.match(/^agent:([^:]+):/)
  return match ? (match[1] ?? null) : null
}

export const isSameSessionKey = (a: string, b: string): boolean => {
  const left = a.trim()
  const right = b.trim()
  return left.length > 0 && left === right
}

// ─── Error detection ──────────────────────────────────────────────────────────

export const isGatewayDisconnectLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  if (!msg) return false
  if (
    msg.includes('gateway not connected') ||
    msg.includes('gateway is not connected') ||
    msg.includes('gateway client stopped')
  ) {
    return true
  }
  const match = msg.match(/gateway closed \((\d+)\)/)
  if (!match) return false
  const code = Number(match[1])
  return Number.isFinite(code) && code === 1012
}

export const isAuthError = (msg: string | null): boolean => {
  if (!msg) return false
  const lower = msg.toLowerCase()
  return (
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('invalid token') ||
    lower.includes('token required') ||
    (lower.includes('token') && lower.includes('not configured')) ||
    lower.includes('gateway_token_missing')
  )
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

export const resolveProxyGatewayUrl = (): string => {
  if (typeof window === 'undefined') return 'ws://localhost:3000/api/gateway/ws'
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.host
  return `${protocol}://${host}/api/gateway/ws`
}

export const isLocalGatewayUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0'
    )
  } catch {
    return false
  }
}

// ─── Error formatting ─────────────────────────────────────────────────────────

const DOCTOR_FIX_HINT =
  'Run `npx openclaw doctor --fix` on the gateway host (or `pnpm openclaw doctor --fix` in a source checkout).'

export const formatGatewayError = (error: unknown): string => {
  if (error instanceof GatewayResponseError) {
    if (error.code === 'INVALID_REQUEST' && /invalid config/i.test(error.message)) {
      return `Gateway error (${error.code}): ${error.message}. ${DOCTOR_FIX_HINT}`
    }
    return `Gateway error (${error.code}): ${error.message}`
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown gateway error.'
}

// ─── Auto retry ───────────────────────────────────────────────────────────────

const MAX_AUTO_RETRY_ATTEMPTS = 20
const INITIAL_RETRY_DELAY_MS = 2_000
const MAX_RETRY_DELAY_MS = 30_000

const NON_RETRYABLE_CONNECT_ERROR_CODES = new Set([
  'studio.gateway_url_missing',
  'studio.gateway_token_missing',
  'studio.gateway_url_invalid',
  'studio.settings_load_failed',
])

export const resolveGatewayAutoRetryDelayMs = (params: AutoRetryDelayParams): number | null => {
  if (params.status !== 'disconnected') return null
  if (!params.didAutoConnect) return null
  if (params.wasManualDisconnect) return null
  if (!params.gatewayUrl.trim()) return null
  if (params.attempt >= MAX_AUTO_RETRY_ATTEMPTS) return null

  const code = params.connectErrorCode?.trim().toLowerCase() ?? ''
  if (code && NON_RETRYABLE_CONNECT_ERROR_CODES.has(code)) return null
  if (params.connectErrorCode === null && isAuthError(params.errorMessage)) return null

  return Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(1.5, params.attempt), MAX_RETRY_DELAY_MS)
}

// ─── Session sync ─────────────────────────────────────────────────────────────

type SessionSettingsPatchPayload = {
  key: string
  model?: string | null
  thinkingLevel?: string | null
  execHost?: 'sandbox' | 'gateway' | 'node' | null
  execSecurity?: 'deny' | 'allowlist' | 'full' | null
  execAsk?: 'off' | 'on-miss' | 'always' | null
}

export const syncGatewaySessionSettings = async ({
  client,
  sessionKey,
  model,
  thinkingLevel,
  execHost,
  execSecurity,
  execAsk,
}: SyncSessionSettingsParams): Promise<SessionPatchResult> => {
  const key = sessionKey.trim()
  if (!key) throw new Error('Session key is required.')

  const includeModel = model !== undefined
  const includeThinkingLevel = thinkingLevel !== undefined
  const includeExecHost = execHost !== undefined
  const includeExecSecurity = execSecurity !== undefined
  const includeExecAsk = execAsk !== undefined

  if (
    !includeModel &&
    !includeThinkingLevel &&
    !includeExecHost &&
    !includeExecSecurity &&
    !includeExecAsk
  ) {
    throw new Error('At least one session setting must be provided.')
  }

  const payload: SessionSettingsPatchPayload = { key }
  if (includeModel) payload.model = model ?? null
  if (includeThinkingLevel) payload.thinkingLevel = thinkingLevel ?? null
  if (includeExecHost) payload.execHost = execHost ?? null
  if (includeExecSecurity) payload.execSecurity = execSecurity ?? null
  if (includeExecAsk) payload.execAsk = execAsk ?? null

  return await client.call<SessionPatchResult>('sessions.patch', payload)
}
