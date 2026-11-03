// A client end of the Agent Client Protocol (ACP): newline-delimited JSON-RPC 2.0
// between clawboo and an agent CLI that speaks it over stdio (`hermes acp`, and in
// principle any other ACP agent). It knows the wire, not any one agent: the caller
// owns the process, feeds stdout lines in, and receives the session updates.
//
// Headless policy: clawboo advertises no file-system or terminal capability, so an
// agent uses its own tools; any such request is refused with "method not found"
// rather than left waiting. A permission request is answered by `onPermission`
// (default: allow once, the same posture as the other runtimes' bypass flags,
// since the task's worktree is the isolation boundary).

/** One `session/update` payload, as the agent sent it (its `update` object). */
export type AcpSessionUpdate = Record<string, unknown>

/** One option of a `session/request_permission` request. */
export interface AcpPermissionOption {
  optionId: string
  kind?: string
  name?: string
}

export interface AcpConnectionHooks {
  /** Write one JSON-RPC message line (the newline is included). */
  write: (line: string) => void
  /** A `session/update` notification arrived. */
  onSessionUpdate: (sessionId: string, update: AcpSessionUpdate) => void
  /** Choose the option to answer a permission request with; null cancels it. */
  onPermission?: (options: AcpPermissionOption[], params: Record<string, unknown>) => string | null
}

export interface AcpConnection {
  /** Feed one line the agent wrote on stdout. */
  onLine(line: string): void
  /** Send a request and wait for its result; rejects with the agent's error. */
  request<T = unknown>(method: string, params: unknown): Promise<T>
  /** Send a notification (no answer expected). */
  notify(method: string, params: unknown): void
  /** Reject every request still waiting: the agent is gone. */
  close(reason: string): void
}

/** An error the agent answered a request with. */
export class AcpRequestError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly data: unknown,
  ) {
    super(message)
    this.name = 'AcpRequestError'
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The option an unattended run grants: allow once, else allow always. */
export function allowOption(options: AcpPermissionOption[]): string | null {
  const pick =
    options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  return pick?.optionId ?? null
}

function permissionOptions(params: Record<string, unknown>): AcpPermissionOption[] {
  const raw = Array.isArray(params['options']) ? params['options'] : []
  const out: AcpPermissionOption[] = []
  for (const o of raw) {
    const r = asRecord(o)
    const optionId = asStr(r?.['optionId'])
    if (!optionId) continue
    out.push({ optionId, kind: asStr(r?.['kind']), name: asStr(r?.['name']) })
  }
  return out
}

export function createAcpConnection(hooks: AcpConnectionHooks): AcpConnection {
  let nextId = 1
  let closed: string | null = null
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const send = (msg: Record<string, unknown>): void => {
    try {
      hooks.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    } catch {
      // A closed pipe surfaces as the process exit, which closes this connection.
    }
  }

  /** A request from the agent: answer it now, never leave it waiting. */
  function answer(id: unknown, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const options = permissionOptions(params)
      const chosen = (hooks.onPermission ?? ((o) => allowOption(o)))(options, params)
      send({
        id,
        result: {
          outcome: chosen ? { outcome: 'selected', optionId: chosen } : { outcome: 'cancelled' },
        },
      })
      return
    }
    // fs/*, terminal/* and anything newer: clawboo advertised none of them.
    send({ id, error: { code: -32601, message: `clawboo does not provide ${method}` } })
  }

  return {
    onLine(line: string): void {
      let msg: Record<string, unknown> | null
      try {
        msg = asRecord(JSON.parse(line))
      } catch {
        return // not protocol: a stray line an agent printed on stdout
      }
      if (!msg) return
      const id = msg['id']
      const method = asStr(msg['method'])
      if (!method && typeof id === 'number' && pending.has(id)) {
        const p = pending.get(id)!
        pending.delete(id)
        const err = asRecord(msg['error'])
        if (err) {
          p.reject(
            new AcpRequestError(
              asStr(err['message']) ?? 'ACP request failed',
              typeof err['code'] === 'number' ? err['code'] : null,
              err['data'],
            ),
          )
        } else p.resolve(msg['result'])
        return
      }
      if (!method) return
      const params = asRecord(msg['params']) ?? {}
      if (id !== undefined && id !== null) {
        answer(id, method, params)
        return
      }
      if (method === 'session/update') {
        const sessionId = asStr(params['sessionId'])
        const update = asRecord(params['update'])
        if (sessionId && update) hooks.onSessionUpdate(sessionId, update)
      }
    },

    request<T>(method: string, params: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new Error(closed))
          return
        }
        const id = nextId++
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        send({ id, method, params })
      })
    },

    notify(method: string, params: unknown): void {
      if (!closed) send({ method, params })
    },

    close(reason: string): void {
      if (closed) return
      closed = reason
      for (const [, p] of pending) p.reject(new Error(reason))
      pending.clear()
    },
  }
}
