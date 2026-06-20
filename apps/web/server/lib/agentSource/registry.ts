// The server-side AgentRegistry singleton. Constructs the OpenClawAgentSource
// (wired to a real GatewayClient whose connect frames are signed with the
// already-paired proxy device identity via the gateway-client `signConnect`
// hook) AND the peer ClawbooNativeAgentSource (SQLite-backed, no substrate),
// and owns the boot/reconnect/shutdown lifecycle. REST handlers resolve the
// OpenClaw source via `getRegistry().source`, the native one via
// `getRegistry().nativeSource`, and route by a row's sourceId through
// `getRegistry().registry`.

import { WebSocket as NodeWebSocket } from 'ws'

import { AgentRegistry } from '@clawboo/agent-registry'
import { loadSettings } from '@clawboo/config'
import { GatewayClient, type WebSocketLikeCtor } from '@clawboo/gateway-client'
import {
  loadOrCreateProxyDeviceIdentity,
  signConnectParams,
  type DeviceIdentity,
} from '@clawboo/gateway-proxy'

import { getDbPath } from '../db'
import { ClawbooNativeAgentSource } from './clawbooNativeAgentSource'
import { OpenClawAgentSource, type OpenClawClientLike } from './openClawAgentSource'

interface RegistryLog {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

/**
 * The Origin to present on the upstream connect — mirrors the gateway-proxy's
 * `resolveOriginForUpstream`: the Gateway's control-ui origin check allows a
 * connection whose Origin is the gateway host itself ("open the Control UI from
 * the gateway host"), so we present `http(s)://<gateway-host>`. A headless Node
 * client sends NO Origin by default (the global undici WebSocket drops it), which
 * is exactly what tripped `CONTROL_UI_ORIGIN_NOT_ALLOWED`.
 */
function resolveServerOrigin(gatewayUrl: string | undefined): string {
  try {
    const url = new URL(gatewayUrl ?? 'ws://localhost:18789')
    const proto = url.protocol === 'wss:' ? 'https:' : 'http:'
    const hostname =
      url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '0.0.0.0'
        ? 'localhost'
        : url.hostname
    const host = url.port ? `${hostname}:${url.port}` : hostname
    return `${proto}//${host}`
  } catch {
    return 'http://localhost:18789'
  }
}

class ServerAgentRegistry {
  readonly registry = new AgentRegistry()
  readonly source: OpenClawAgentSource
  readonly nativeSource: ClawbooNativeAgentSource
  private log: RegistryLog | null = null
  private identityPromise: Promise<DeviceIdentity> | null = null
  // The clawboo server base URL — set at boot once the port is resolved, so the
  // source can register clawboo's MCP servers in the Gateway config.
  private mcpBaseUrl: string | null = null

  constructor() {
    this.source = new OpenClawAgentSource({
      getDbPath,
      loadSettings: () => {
        const s = loadSettings(process.env)
        return { gatewayUrl: s.gatewayUrl, gatewayToken: s.gatewayToken }
      },
      mcpBaseUrl: () => this.mcpBaseUrl,
      makeClient: () => new GatewayClient() as unknown as OpenClawClientLike,
      connectOptions: () => {
        const s = loadSettings(process.env)
        return {
          // The Gateway validates client.id against a fixed allowlist
          // (OpenClaw 2026.5.x+): a custom id like 'clawboo-server' is rejected
          // with `invalid connect params: at /client/id` and the WS closes 1008,
          // leaving the server-side sync source permanently disconnected (every
          // agent-file read/write then 503s). We must use an ALLOWED id — and a
          // NON-browser one: the control-ui ids ('openclaw-control-ui',
          // 'webchat-ui') additionally require a browser Origin header
          // (CONTROL_UI_ORIGIN_NOT_ALLOWED) that a headless Node connection can't
          // send. 'cli' is the first-class programmatic client type — no origin
          // requirement — and we still authenticate with the proxy device
          // identity (signConnect below) + the gateway token.
          clientName: 'cli',
          mode: 'webchat',
          token: s.gatewayToken?.trim() || undefined,
          // The browser device path needs crypto.subtle + localStorage (absent in
          // Node); we sign with the proxy identity instead. Both flags set on
          // purpose: disableDeviceAuth skips the browser path, signConnect runs ours.
          disableDeviceAuth: true,
          signConnect: (params: Record<string, unknown>, nonce: string | null) =>
            this.signConnect(params, nonce),
          // The global undici WebSocket can't set an Origin, so a headless connect
          // hits CONTROL_UI_ORIGIN_NOT_ALLOWED. Inject the `ws` package's WebSocket
          // (which honours `{ origin }`) + the gateway-host origin the proxy uses —
          // the proven recipe from gateway-proxy's upstream connection.
          origin: resolveServerOrigin(s.gatewayUrl),
          webSocketImpl: NodeWebSocket as unknown as WebSocketLikeCtor,
        }
      },
      log: (level, obj, msg) => this.log?.[level]?.(obj, msg),
    })
    this.registry.register(this.source)
    this.nativeSource = new ClawbooNativeAgentSource({ getDbPath })
    this.registry.register(this.nativeSource)
  }

  private async signConnect(
    params: Record<string, unknown>,
    nonce: string | null,
  ): ReturnType<typeof signConnectParams> {
    this.identityPromise ??= loadOrCreateProxyDeviceIdentity()
    const identity = await this.identityPromise
    return signConnectParams(identity, params, nonce)
  }

  async start(opts?: { log?: RegistryLog; mcpBaseUrl?: string }): Promise<void> {
    if (opts?.log) this.log = opts.log
    if (opts?.mcpBaseUrl) this.mcpBaseUrl = opts.mcpBaseUrl
    await this.source.start()
  }

  async stop(): Promise<void> {
    await this.source.stop()
  }

  async reconnect(): Promise<void> {
    await this.source.reconnect()
  }
}

let singleton: ServerAgentRegistry | null = null

/** Process-wide AgentRegistry singleton (mirrors getDbPath()'s module-singleton). */
export function getRegistry(): ServerAgentRegistry {
  singleton ??= new ServerAgentRegistry()
  return singleton
}

let shutdownWired = false
function wireShutdown(): void {
  if (shutdownWired) return
  shutdownWired = true
  const stop = (): void => {
    void singleton?.stop()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
wireShutdown()
