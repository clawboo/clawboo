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

// ─── Synthetic agent replies ──────────────────────────────────────────────────
// The mock pushes `chat` event frames after a `chat.send` so the board e2e can
// drive a real chat→board→chat round-trip. The reply depends on who's targeted
// and what they were sent:
//   • a wake/resume ping → the silent `__resumed__` token (no work).
//   • the leader (a1 / Boo Zero) given a normal user message → a structured
//     `<delegate>` to Research Boo (triggers the derive → a board task).
//   • the leader given a `[Task Update]` reflection → a plain synthesis (NO
//     delegate, so it can't loop).
//   • a specialist (a2 / Research Boo) → a report-up summary (drives `done`).
function synthesizeReply(agentId: string, message: string): string {
  // Only an ACTUAL wake ping starts with the resume marker. (A real user
  // message to Boo Zero embeds the rules block, which mentions the resume
  // protocol — so match the start, not a substring, to avoid false positives.)
  if (message.startsWith('[RESUME_SIGNAL')) return '__resumed__'
  if (message.startsWith('[Task Update]')) return 'Synthesis complete — all subtasks are done.'
  if (agentId === 'a1')
    return '<delegate to="@Research Boo">Investigate the question and report back.</delegate>'
  if (agentId === 'a2') return 'Research complete: the answer is 42.'
  return 'Acknowledged.'
}

// ─── startMockGateway ───────────────────────────────────────────────────────

export async function startMockGateway(): Promise<MockGateway> {
  const received: Frame[] = []
  let runCounter = 0

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

        case 'chat.send': {
          ws.send(JSON.stringify({ type: 'res', id, ok: true, payload: {} }))
          // Push a synthetic `chat` final frame so the adapter maps it to a
          // `done` RuntimeEvent and the board orchestration can act on it. The
          // frame shape matches what `parseChatPayload` + `extractText` expect.
          const params = frame.params ?? {}
          const sessionKey = typeof params['sessionKey'] === 'string' ? params['sessionKey'] : ''
          const message = typeof params['message'] === 'string' ? params['message'] : ''
          const agentId = sessionKey.match(/^agent:([^:]+):/)?.[1] ?? ''
          if (sessionKey) {
            const runId = `run-${++runCounter}`
            const content = synthesizeReply(agentId, message)
            setTimeout(() => {
              if (ws.readyState !== WebSocket.OPEN) return
              ws.send(
                JSON.stringify({
                  type: 'event',
                  event: 'chat',
                  payload: {
                    runId,
                    sessionKey,
                    state: 'final',
                    message: { role: 'assistant', content },
                  },
                }),
              )
            }, 60)
          }
          break
        }

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
