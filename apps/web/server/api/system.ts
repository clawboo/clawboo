import type { Request, Response } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { resolveStateDir, saveSettings } from '@clawboo/config'
import {
  readGatewayPid,
  writeGatewayPid,
  removeGatewayPid,
  isProcessAlive,
  probeGatewayPort,
  findProcessByPort,
} from '../lib/processManager'
import { getModelsFromCli } from '../lib/modelCache'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 18789

function sendEvent(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function detectOpenClaw(): { installed: boolean; version: string | null; path: string | null } {
  try {
    const binPath = execFileSync('which', ['openclaw'], { encoding: 'utf8' }).trim()
    if (!binPath) return { installed: false, version: null, path: null }
    try {
      const raw = execFileSync(binPath, ['--version'], { encoding: 'utf8' }).trim()
      const version = raw.replace(/^openclaw\s+v?/i, '').trim() || raw
      return { installed: true, version, path: binPath }
    } catch {
      return { installed: true, version: null, path: binPath }
    }
  } catch {
    return { installed: false, version: null, path: null }
  }
}

function readOpenclawJson(stateDir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function readEnvFile(stateDir: string): string | null {
  try {
    return fs.readFileSync(path.join(stateDir, '.env'), 'utf8')
  } catch {
    return null
  }
}

// Provider ID → auth-profiles provider name mapping
const AUTH_PROFILE_PROVIDERS: Record<string, string> = {
  hasAnthropicKey: 'anthropic',
  hasOpenAIKey: 'openai',
  hasGoogleKey: 'google',
  hasOpenRouterKey: 'openrouter',
  hasXaiKey: 'xai',
  hasGroqKey: 'groq',
  hasMistralKey: 'mistral',
  hasMoonshotKey: 'moonshot',
  hasMiniMaxKey: 'minimax',
  hasTogetherKey: 'together',
  hasNvidiaKey: 'nvidia',
  hasHuggingFaceKey: 'huggingface',
  hasCerebrasKey: 'cerebras',
  hasVeniceKey: 'venice',
}

/**
 * Scan agent auth-profiles.json files to detect which providers have keys.
 * OpenClaw stores actual API keys in per-agent auth-profiles, not always in .env.
 */
function detectAuthProfileKeys(stateDir: string): Set<string> {
  const providers = new Set<string>()
  try {
    const agentsDir = path.join(stateDir, 'agents')
    if (!fs.existsSync(agentsDir)) return providers
    const agentIds = fs.readdirSync(agentsDir)
    for (const agentId of agentIds) {
      const profilePath = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json')
      try {
        const raw = fs.readFileSync(profilePath, 'utf8')
        const data = JSON.parse(raw) as {
          profiles?: Record<string, { provider?: string; key?: string }>
        }
        if (data.profiles) {
          for (const profile of Object.values(data.profiles)) {
            if (profile.provider && profile.key) {
              providers.add(profile.provider)
            }
          }
        }
      } catch {
        // Skip agents without auth-profiles
      }
      // Only need to check one agent — keys are typically shared
      if (providers.size > 0) break
    }
  } catch {
    // Non-fatal
  }
  return providers
}

/**
 * Get list of all agent directories that have auth-profiles.json files.
 */
function getAgentAuthProfilePaths(stateDir: string): string[] {
  const paths: string[] = []
  try {
    const agentsDir = path.join(stateDir, 'agents')
    if (!fs.existsSync(agentsDir)) return paths
    const agentIds = fs.readdirSync(agentsDir)
    for (const agentId of agentIds) {
      const profilePath = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json')
      if (fs.existsSync(profilePath)) {
        paths.push(profilePath)
      }
    }
  } catch {
    // Non-fatal
  }
  return paths
}

// Shared provider → env var name mapping (used in configure + PATCH handlers)
const ENV_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  together: 'TOGETHER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  huggingface: 'HF_TOKEN',
  cerebras: 'CEREBRAS_API_KEY',
  venice: 'VENICE_API_KEY',
}

function parseEnvFlags(content: string | null): Record<string, boolean> {
  const FLAG_CHECKS: Record<string, string[]> = {
    hasAnthropicKey: ['ANTHROPIC_API_KEY'],
    hasOpenAIKey: ['OPENAI_API_KEY'],
    hasGoogleKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    hasOpenRouterKey: ['OPENROUTER_API_KEY'],
    hasXaiKey: ['XAI_API_KEY'],
    hasGroqKey: ['GROQ_API_KEY'],
    hasMistralKey: ['MISTRAL_API_KEY'],
    hasMoonshotKey: ['MOONSHOT_API_KEY'],
    hasMiniMaxKey: ['MINIMAX_API_KEY'],
    hasTogetherKey: ['TOGETHER_API_KEY'],
    hasNvidiaKey: ['NVIDIA_API_KEY'],
    hasHuggingFaceKey: ['HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN'],
    hasCerebrasKey: ['CEREBRAS_API_KEY'],
    hasVeniceKey: ['VENICE_API_KEY'],
    hasGatewayToken: ['GATEWAY_AUTH_TOKEN'],
  }
  const flags: Record<string, boolean> = {}
  for (const key of Object.keys(FLAG_CHECKS)) flags[key] = false
  if (!content) return flags
  const cleaned = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  for (const [flag, vars] of Object.entries(FLAG_CHECKS)) {
    flags[flag] = vars.some((v) => cleaned.some((l) => l.startsWith(`${v}=`)))
  }
  return flags
}

function resolvePort(stateDir: string): number {
  const pidInfo = readGatewayPid()
  if (pidInfo) return pidInfo.port
  const config = readOpenclawJson(stateDir)
  if (config) {
    const gw = config['gateway']
    if (gw && typeof gw === 'object' && !Array.isArray(gw)) {
      const port = (gw as Record<string, unknown>)['port']
      if (typeof port === 'number' && Number.isFinite(port) && port > 0) return port
    }
  }
  return DEFAULT_PORT
}

async function stopGateway(port: number): Promise<{ stopped: boolean; message?: string }> {
  const pidInfo = readGatewayPid()
  let targetPid: number | null = pidInfo?.pid ?? null

  if (targetPid && !isProcessAlive(targetPid)) {
    removeGatewayPid()
    targetPid = null
  }

  if (!targetPid) {
    targetPid = findProcessByPort(port)
  }

  if (!targetPid) {
    removeGatewayPid()
    return { stopped: false, message: 'No gateway process found' }
  }

  try {
    process.kill(targetPid, 'SIGTERM')
  } catch {
    removeGatewayPid()
    return { stopped: true }
  }

  // Wait up to 2s for graceful shutdown
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (!isProcessAlive(targetPid)) {
      removeGatewayPid()
      return { stopped: true }
    }
  }

  // Force kill
  try {
    process.kill(targetPid, 'SIGKILL')
  } catch {
    // already dead
  }
  removeGatewayPid()
  return { stopped: true }
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

// GET /api/system/status
export async function systemStatusGET(_req: Request, res: Response): Promise<void> {
  try {
    const nodeVersion = process.version
    const major = parseInt(nodeVersion.slice(1), 10)

    const oc = detectOpenClaw()

    const stateDir = resolveStateDir()
    const configExists = fs.existsSync(path.join(stateDir, 'openclaw.json'))
    const envExists = fs.existsSync(path.join(stateDir, '.env'))

    const port = resolvePort(stateDir)
    const pidInfo = readGatewayPid()
    const pidAlive = pidInfo ? isProcessAlive(pidInfo.pid) : false
    const reachable = await probeGatewayPort(port)
    const running = pidAlive || reachable

    // Clean up stale PID file
    if (pidInfo && !pidAlive) {
      removeGatewayPid()
    }

    res.json({
      node: {
        version: nodeVersion,
        major,
        sufficient: major >= 22,
        path: process.execPath,
      },
      openclaw: {
        installed: oc.installed,
        version: oc.version,
        path: oc.path,
        stateDir,
        configExists,
        envExists,
      },
      gateway: {
        running,
        port,
        pid: pidAlive ? pidInfo!.pid : null,
        managedByClawboo: pidAlive,
        uptimeMs: pidAlive && pidInfo ? Date.now() - pidInfo.startedAt : null,
      },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// POST /api/system/install-openclaw
export async function installOpenclawPOST(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  sendEvent(res, { type: 'progress', step: 'installing', message: 'Installing OpenClaw...' })

  const child = spawn('npm', ['install', '-g', 'openclaw@latest'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      sendEvent(res, { type: 'output', line })
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (text.includes('EACCES') || text.toLowerCase().includes('permission denied')) {
      sendEvent(res, {
        type: 'error',
        code: 'EACCES',
        message:
          'Permission denied. Your Node.js installation may require sudo for global installs. Try: sudo npm install -g openclaw@latest',
      })
    }
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines) {
      sendEvent(res, { type: 'output', line })
    }
  })

  child.on('error', (err) => {
    sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: String(err) })
    res.end()
  })

  child.on('close', (code) => {
    if (code === 0) {
      const oc = detectOpenClaw()
      sendEvent(res, { type: 'complete', success: true, version: oc.version ?? 'unknown' })
    } else {
      sendEvent(res, {
        type: 'error',
        code: `EXIT_${code}`,
        message: `Installation failed with exit code ${code}`,
      })
    }
    res.end()
  })

  res.on('close', () => {
    if (!child.killed) child.kill()
  })
}

// POST /api/system/configure-openclaw
export function configureOpenclawPOST(req: Request, res: Response): void {
  try {
    const body = req.body as Record<string, unknown> | undefined
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'JSON body required' })
      return
    }

    const provider = body['provider']
    const apiKey = body['apiKey']
    const model = body['model']
    const gatewayPort = body['gatewayPort']

    if (typeof provider !== 'string' || !provider) {
      res.status(400).json({ error: 'provider is required' })
      return
    }
    if (provider !== 'ollama' && (typeof apiKey !== 'string' || !apiKey)) {
      res.status(400).json({ error: 'apiKey is required for non-ollama providers' })
      return
    }

    const port = typeof gatewayPort === 'number' && gatewayPort > 0 ? gatewayPort : DEFAULT_PORT

    const stateDir = resolveStateDir()
    fs.mkdirSync(path.join(stateDir, 'workspace'), { recursive: true })

    const gatewayToken = crypto.randomBytes(32).toString('hex')

    // Resolve model from provider
    const MODEL_MAP: Record<string, string> = {
      anthropic: 'anthropic/claude-sonnet-4-5',
      openai: 'openai/gpt-5.4',
      google: 'google/gemini-2.0-flash',
      openrouter: 'openrouter/anthropic/claude-sonnet-4-5',
      xai: 'xai/grok-3',
      groq: 'groq/llama-3.3-70b-versatile',
      mistral: 'mistral/mistral-large-latest',
      moonshot: 'moonshot/kimi-k2.5',
      minimax: 'minimax/MiniMax-M2.5',
      together: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
      nvidia: 'nvidia/llama-3.1-nemotron-70b-instruct',
      huggingface: 'huggingface/deepseek-ai/DeepSeek-R1',
      cerebras: 'cerebras/zai-glm-4.7',
      venice: 'venice/llama-3.3-70b',
      ollama: 'ollama/llama3.2',
    }
    const resolvedModel =
      typeof model === 'string' && model
        ? model
        : (MODEL_MAP[provider] ?? `${provider}/${model ?? 'default'}`)

    // Write openclaw.json
    const openclawConfig = {
      gateway: {
        port,
        auth: { mode: 'token', token: '${GATEWAY_AUTH_TOKEN}' },
      },
      agents: {
        defaults: {
          model: { primary: resolvedModel },
        },
      },
    }
    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify(openclawConfig, null, 2),
      'utf8',
    )

    // Build .env
    let envContent = `GATEWAY_AUTH_TOKEN=${gatewayToken}\n`
    const envKeyName = ENV_KEY_MAP[provider]
    if (envKeyName && typeof apiKey === 'string' && apiKey) {
      envContent += `${envKeyName}=${apiKey}\n`
    } else if (provider !== 'ollama' && typeof apiKey === 'string' && apiKey) {
      envContent += `CUSTOM_API_KEY=${apiKey}\n`
    }
    fs.writeFileSync(path.join(stateDir, '.env'), envContent, 'utf8')

    // Auto-save to Clawboo settings
    const gatewayUrl = `ws://localhost:${port}`
    saveSettings({ gatewayUrl, gatewayToken })

    res.json({ ok: true, gatewayToken, gatewayUrl })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// POST /api/system/gateway
export async function gatewayControlPOST(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown> | undefined
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'JSON body required' })
      return
    }

    const action = body['action']
    if (action !== 'start' && action !== 'stop' && action !== 'restart' && action !== 'status') {
      res.status(400).json({ error: "action must be 'start', 'stop', 'restart', or 'status'" })
      return
    }

    const stateDir = resolveStateDir()
    const port = resolvePort(stateDir)

    // ── status ──
    if (action === 'status') {
      const pidInfo = readGatewayPid()
      const alive = pidInfo ? isProcessAlive(pidInfo.pid) : false
      const reachable = await probeGatewayPort(port)
      if (pidInfo && !alive) removeGatewayPid()
      res.json({
        running: alive || reachable,
        pid: alive ? pidInfo!.pid : null,
        port,
        uptimeMs: alive && pidInfo ? Date.now() - pidInfo.startedAt : null,
      })
      return
    }

    // ── stop ──
    if (action === 'stop') {
      const result = await stopGateway(port)
      if (result.stopped) {
        res.json({ ok: true, stopped: true })
      } else {
        res.json({ ok: false, message: result.message ?? 'No gateway process found' })
      }
      return
    }

    // ── start / restart (SSE) ──
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    if (action === 'restart') {
      sendEvent(res, { type: 'progress', step: 'stopping', message: 'Stopping gateway...' })
      await stopGateway(port)
      // Brief delay to let port free up
      await new Promise((r) => setTimeout(r, 500))
    }

    // Check if already running (for start only)
    if (action === 'start') {
      const reachable = await probeGatewayPort(port)
      if (reachable) {
        sendEvent(res, {
          type: 'complete',
          success: true,
          message: 'Gateway already running',
          port,
        })
        res.end()
        return
      }
    }

    // Find openclaw binary
    const oc = detectOpenClaw()
    if (!oc.installed || !oc.path) {
      sendEvent(res, { type: 'error', code: 'NOT_INSTALLED', message: 'OpenClaw is not installed' })
      res.end()
      return
    }

    sendEvent(res, {
      type: 'progress',
      step: 'starting',
      message: `Starting gateway on port ${port}...`,
    })

    const child = spawn(oc.path, ['gateway', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.unref()

    if (child.pid) {
      writeGatewayPid(child.pid, port)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        sendEvent(res, { type: 'output', line })
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        sendEvent(res, { type: 'output', line })
      }
    })

    child.on('error', (err) => {
      sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: String(err) })
      removeGatewayPid()
      res.end()
    })

    // Poll until gateway is reachable
    let attempts = 0
    const maxAttempts = 30
    const poll = async () => {
      attempts++
      const reachable = await probeGatewayPort(port)
      if (reachable) {
        sendEvent(res, { type: 'complete', success: true, pid: child.pid, port })
        res.end()
        return
      }
      if (attempts >= maxAttempts) {
        sendEvent(res, {
          type: 'error',
          code: 'TIMEOUT',
          message: `Gateway did not become reachable within ${maxAttempts / 2}s`,
        })
        res.end()
        return
      }
      sendEvent(res, {
        type: 'progress',
        step: 'waiting',
        message: `Waiting for gateway... (${attempts}/${maxAttempts})`,
      })
      setTimeout(() => void poll(), 500)
    }
    // Start polling after a brief delay
    setTimeout(() => void poll(), 500)

    // Do NOT kill detached child on client disconnect
    res.on('close', () => {
      // Intentionally empty — gateway should keep running
    })
  } catch (err) {
    // If headers already sent (SSE mode), just end
    if (res.headersSent) {
      sendEvent(res, { type: 'error', code: 'INTERNAL', message: String(err) })
      res.end()
    } else {
      res.status(500).json({ error: String(err) })
    }
  }
}

// GET /api/system/openclaw-config
export function openclawConfigGET(_req: Request, res: Response): void {
  try {
    const stateDir = resolveStateDir()
    const config = readOpenclawJson(stateDir)
    const envContent = readEnvFile(stateDir)
    const env = parseEnvFlags(envContent)
    const oc = detectOpenClaw()

    // Also check auth-profiles.json for configured providers
    const authProviders = detectAuthProfileKeys(stateDir)
    for (const [flag, provider] of Object.entries(AUTH_PROFILE_PROVIDERS)) {
      if (authProviders.has(provider)) {
        env[flag] = true
      }
    }

    res.json({
      config,
      env,
      version: oc.version,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// PATCH /api/system/openclaw-config
export async function openclawConfigPATCH(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown> | undefined
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'JSON body required' })
      return
    }

    const stateDir = resolveStateDir()
    const configPath = path.join(stateDir, 'openclaw.json')

    // Read-modify-write openclaw.json
    let config: Record<string, unknown> = {}
    try {
      const raw = fs.readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>
      }
    } catch {
      // Start fresh if file missing or corrupt
    }

    const modelField = body['model']
    const fallbacks = body['fallbacks']
    const gatewayPort = body['gatewayPort']
    const apiKeys = body['apiKeys']
    const agentModelField = body['agentModel']

    // Ensure nested structure
    if (!config['agents'] || typeof config['agents'] !== 'object') config['agents'] = {}
    const agents = config['agents'] as Record<string, unknown>
    if (!agents['defaults'] || typeof agents['defaults'] !== 'object') agents['defaults'] = {}
    const defaults = agents['defaults'] as Record<string, unknown>
    if (!defaults['model'] || typeof defaults['model'] !== 'object') defaults['model'] = {}
    const modelObj = defaults['model'] as Record<string, unknown>

    if (typeof modelField === 'string' && modelField) {
      modelObj['primary'] = modelField
    }
    if (Array.isArray(fallbacks)) {
      modelObj['fallbacks'] = fallbacks.filter((f): f is string => typeof f === 'string')
    }

    if (!config['gateway'] || typeof config['gateway'] !== 'object') config['gateway'] = {}
    const gateway = config['gateway'] as Record<string, unknown>

    if (typeof gatewayPort === 'number' && gatewayPort > 0) {
      gateway['port'] = gatewayPort
    }

    // Per-agent model override → agents.list[]
    if (agentModelField && typeof agentModelField === 'object' && !Array.isArray(agentModelField)) {
      const am = agentModelField as Record<string, unknown>
      const agentId = am['agentId']
      const agentModel = am['model']

      if (typeof agentId === 'string' && agentId) {
        if (!agents['list'] || !Array.isArray(agents['list'])) agents['list'] = []
        const list = agents['list'] as Record<string, unknown>[]

        const existingIdx = list.findIndex(
          (entry) => entry && typeof entry === 'object' && entry['id'] === agentId,
        )

        if (agentModel === null || agentModel === '') {
          // Remove per-agent model override (revert to default)
          if (existingIdx >= 0) {
            const entry = list[existingIdx] as Record<string, unknown>
            delete entry['model']
            // Remove entry entirely if only 'id' key remains
            const keys = Object.keys(entry).filter((k) => k !== 'id')
            if (keys.length === 0) {
              list.splice(existingIdx, 1)
            }
          }
        } else if (typeof agentModel === 'string') {
          // Set per-agent model override
          if (existingIdx >= 0) {
            ;(list[existingIdx] as Record<string, unknown>)['model'] = agentModel
          } else {
            list.push({ id: agentId, model: agentModel })
          }
        }
      }
    }

    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    // Update .env if apiKeys provided
    if (Array.isArray(apiKeys) && apiKeys.length > 0) {
      const envPath = path.join(stateDir, '.env')
      let envLines: string[] = []
      try {
        envLines = fs.readFileSync(envPath, 'utf8').split('\n')
      } catch {
        // Start fresh
      }

      for (const entry of apiKeys) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const provider = e['provider']
        const key = e['key']
        if (typeof provider !== 'string' || typeof key !== 'string') continue

        const envVarName = ENV_KEY_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`
        const existingIdx = envLines.findIndex((l) => l.trim().startsWith(`${envVarName}=`))
        const newLine = `${envVarName}=${key}`
        if (existingIdx >= 0) {
          envLines[existingIdx] = newLine
        } else {
          envLines.push(newLine)
        }
      }

      // Clean trailing empty lines but ensure final newline
      while (envLines.length > 0 && envLines[envLines.length - 1] === '') {
        envLines.pop()
      }
      fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8')

      // Also update auth-profiles.json for all existing agents
      const profilePaths = getAgentAuthProfilePaths(stateDir)
      for (const entry of apiKeys) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const provider = e['provider']
        const key = e['key']
        if (typeof provider !== 'string' || typeof key !== 'string') continue

        const profileName = `${provider}:default`
        for (const profilePath of profilePaths) {
          try {
            let data: Record<string, unknown> = {
              version: 1,
              profiles: {},
              lastGood: {},
              usageStats: {},
            }
            try {
              const raw = fs.readFileSync(profilePath, 'utf8')
              const parsed = JSON.parse(raw) as unknown
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                data = parsed as Record<string, unknown>
              }
            } catch {
              // Start fresh
            }
            if (!data['profiles'] || typeof data['profiles'] !== 'object') data['profiles'] = {}
            const profiles = data['profiles'] as Record<string, unknown>
            profiles[profileName] = { type: 'api_key', provider, key }
            if (!data['lastGood'] || typeof data['lastGood'] !== 'object') data['lastGood'] = {}
            const lastGood = data['lastGood'] as Record<string, unknown>
            lastGood[provider] = profileName
            fs.writeFileSync(profilePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
          } catch {
            // Best-effort per agent
          }
        }
      }
    }

    // Update Clawboo settings if port changed
    if (typeof gatewayPort === 'number' && gatewayPort > 0) {
      saveSettings({ gatewayUrl: `ws://localhost:${gatewayPort}` })
    }

    // Check if gateway is running for hot reload hint
    const port = resolvePort(stateDir)
    const reachable = await probeGatewayPort(port)

    res.json({ ok: true, ...(reachable ? { hotReloadHint: true } : {}) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── Models (dynamic catalog from CLI) ───────────────────────────────────────

export async function systemModelsGET(_req: Request, res: Response): Promise<void> {
  try {
    const groups = await getModelsFromCli()
    res.json({ groups })
  } catch {
    res.json({ groups: null })
  }
}
