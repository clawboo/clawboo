import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Frame {
  type: string
  id?: string
  method?: string
  params?: Record<string, unknown>
}

export interface MockGateway {
  /** WebSocket URL (e.g. ws://127.0.0.1:54321) */
  url: string
  /** Port the server is listening on */
  port: number
  /** Shut down the server */
  close: () => void
  /** All received frames (for assertions) */
  received: Frame[]
}

// ─── Mock agents ────────────────────────────────────────────────────────────

const MOCK_AGENTS = [
  {
    id: 'a1',
    name: 'Test Boo',
    identity: { name: 'Test Boo' },
    status: 'idle',
  },
  {
    id: 'a2',
    name: 'Research Boo',
    identity: { name: 'Research Boo' },
    status: 'idle',
  },
]

// ─── startMockGateway ───────────────────────────────────────────────────────

export async function startMockGateway(): Promise<MockGateway> {
  const received: Frame[] = []

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })

  await new Promise<void>((resolve) => {
    wss.on('listening', resolve)
  })

  const { port } = wss.address() as AddressInfo

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
      let frame: Frame
      try {
        frame = JSON.parse(text) as Frame
      } catch {
        return
      }

      received.push(frame)

      if (frame.type !== 'req' || !frame.id) return

      const { id, method } = frame

      switch (method) {
        case 'connect':
          ws.send(
            JSON.stringify({
              type: 'res',
              id,
              ok: true,
              payload: { protocol: 3 },
            }),
          )
          break

        case 'agents.list':
          ws.send(
            JSON.stringify({
              type: 'res',
              id,
              ok: true,
              payload: {
                defaultId: 'a1',
                mainKey: 'main',
                agents: MOCK_AGENTS,
              },
            }),
          )
          break

        case 'chat.send':
          ws.send(
            JSON.stringify({
              type: 'res',
              id,
              ok: true,
              payload: {},
            }),
          )
          break

        case 'agents.files.read':
          // client.call<string>() resolves with res.payload directly
          ws.send(
            JSON.stringify({
              type: 'res',
              id,
              ok: true,
              payload: '',
            }),
          )
          break

        default:
          ws.send(
            JSON.stringify({
              type: 'res',
              id,
              ok: true,
              payload: {},
            }),
          )
          break
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    close: () => wss.close(),
    received,
  }
}
