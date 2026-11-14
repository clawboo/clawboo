// HTTP client for Hermes's gateway API server, the one long-lived Hermes that
// Clawboo supervises. Every Clawboo Hermes agent is a Hermes profile, reached at
// `/p/<profile>/...` with that profile's own key.
//
// What the API server in v0.23.1 does, as verified against its source and a
// live gateway (these shape the driver):
//   - Auth is `Authorization: Bearer <key>`. A profile route takes only that
//     profile's key; the root key gets 401 there.
//   - `POST /v1/runs` reads `input`, `instructions`, `session_id`, `model`,
//     `provider` (and a few more). It has no working folder and no MCP servers:
//     both come from the profile's own config. An unknown `session_id` starts a
//     new session under that id. The 202 says `started` even when queued.
//   - `GET /v1/runs/{id}/events` is SSE with no `event:` line: the name is the
//     JSON `event` field. It replays from the start (or `Last-Event-ID`), and the
//     buffer is dropped about five minutes after a run that nobody watches.
//   - Approval and steer and stop are POSTs on the run. A steer is taken only
//     while the run is exactly `running`.
//
// The key never leaves this module except in the Authorization header: no
// error message, log line or return value carries it.

import { createSseReader } from './sse'

export interface HermesEndpoint {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  baseUrl: string
  /** The profile, or null for the root (gateway-level) routes. */
  profile: string | null
  key: string
}

export class HermesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'HermesApiError'
  }
}

/** A run event, as the API server sends it: its name is `event`. */
export interface HermesRunEvent {
  event: string
  run_id?: string
  seq?: number
  [field: string]: unknown
}

export interface HermesRunStatus {
  run_id: string
  status: string
  session_id?: string
  output?: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  execution_generation?: number
  [field: string]: unknown
}

export interface StartRunBody {
  input: string
  instructions?: string
  session_id?: string
  model?: string
  provider?: string
}

/** A job in a profile's own scheduler (`cron/jobs.json`). */
export interface HermesJob {
  id: string
  name: string
  prompt?: string
  enabled?: boolean
  state?: string
  schedule?: { kind?: string; expr?: string; minutes?: number; run_at?: string; display?: string }
  schedule_display?: string
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
  live_execution?: unknown
  [field: string]: unknown
}

type FetchLike = typeof fetch

const DEFAULT_TIMEOUT_MS = 15_000

/** How long a run's event stream may send nothing before it is given up and
 *  read again. Hermes sends a keepalive comment every 10 s on a quiet run, so a
 *  stream silent this long is stuck, not a long tool call. */
export const STREAM_IDLE_MS = 60_000

export interface HermesClient {
  readonly endpoint: Pick<HermesEndpoint, 'baseUrl' | 'profile'>
  health(timeoutMs?: number): Promise<{ status: string; version?: string }>
  /** `idempotencyKey`: the same key sent again returns the run it started, so a
   *  start whose answer was lost can learn its run instead of starting another. */
  startRun(body: StartRunBody, opts?: { idempotencyKey?: string }): Promise<{ runId: string }>
  getRun(runId: string): Promise<HermesRunStatus>
  /** Stream a run's events until it ends, the signal aborts, or the stream closes.
   *  Resolves when the stream ends; rejects on a transport or HTTP failure, and
   *  when nothing at all, not even a keepalive, arrives for `idleMs`. */
  streamEvents(
    runId: string,
    onEvent: (ev: HermesRunEvent) => void,
    opts?: { signal?: AbortSignal; lastSeq?: number; idleMs?: number },
  ): Promise<void>
  stopRun(runId: string): Promise<void>
  steer(runId: string, text: string): Promise<void>
  answerApproval(
    runId: string,
    answer: { requestId: string; executionGeneration: number; choice: HermesApprovalChoice },
  ): Promise<void>
  listJobs(): Promise<HermesJob[]>
  getJob(id: string): Promise<HermesJob>
  createJob(job: { name: string; schedule: string; prompt: string }): Promise<HermesJob>
  updateJob(id: string, patch: Record<string, unknown>): Promise<HermesJob | null>
  deleteJob(id: string): Promise<void>
  pauseJob(id: string): Promise<void>
  resumeJob(id: string): Promise<void>
  runJob(id: string): Promise<void>
}

export type HermesApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/** A job id Hermes mints: 12 hex. Anything else is refused before it reaches a URL. */
const JOB_ID_RE = /^[a-f0-9]{12}$/
/** A run id Hermes mints (`run_<hex>`), or a session-named one. */
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/
/** A profile name, as Hermes accepts it. */
export const HERMES_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function assertId(re: RegExp, id: string, what: string): string {
  if (!re.test(id)) throw new HermesApiError(`not a Hermes ${what} id`, 400, 'bad_id')
  return encodeURIComponent(id)
}

async function errorOf(res: Response): Promise<HermesApiError> {
  let message = `Hermes answered ${res.status}`
  let code: string | null = null
  try {
    const body = (await res.json()) as {
      error?: { message?: unknown; code?: unknown } | string
      code?: unknown
    }
    const e = body.error
    if (typeof e === 'string') message = e
    else if (e && typeof e === 'object') {
      if (typeof e.message === 'string' && e.message) message = e.message
      if (typeof e.code === 'string') code = e.code
    }
    if (!code && typeof body.code === 'string') code = body.code
  } catch {
    // Not JSON: keep the status line.
  }
  return new HermesApiError(message.slice(0, 500), res.status, code)
}

/** Read a run's event stream body to its end, calling `onChunk` as each piece
 *  of it arrives (a keepalive comment included). */
async function readEvents(
  body: AsyncIterable<Uint8Array>,
  onEvent: (ev: HermesRunEvent) => void,
  onChunk: () => void,
): Promise<void> {
  let overflow = false
  const reader = createSseReader(
    (ev) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(ev.data)
      } catch {
        return
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as HermesRunEvent).event === 'string'
      ) {
        const runEv = parsed as HermesRunEvent
        // v0.23.1 puts the sequence in the JSON too; the frame's id is the
        // same number, and the one to trust when the JSON leaves it out.
        if (typeof runEv.seq !== 'number' && ev.id && /^\d{1,15}$/.test(ev.id))
          runEv.seq = Number(ev.id)
        onEvent(runEv)
      }
    },
    { onOverflow: () => (overflow = true) },
  )
  const decoder = new TextDecoder()
  for await (const chunk of body) {
    onChunk()
    reader.push(decoder.decode(chunk, { stream: true }))
    if (overflow) throw new HermesApiError('Hermes sent an event too large to read', 502, null)
  }
  reader.push(decoder.decode())
  reader.end()
}

export function createHermesClient(
  endpoint: HermesEndpoint,
  deps: { fetch?: FetchLike } = {},
): HermesClient {
  const doFetch = deps.fetch ?? fetch
  if (endpoint.profile !== null && !HERMES_PROFILE_RE.test(endpoint.profile)) {
    throw new HermesApiError('not a Hermes profile name', 400, 'bad_profile')
  }
  const prefix = endpoint.profile ? `/p/${endpoint.profile}` : ''
  const url = (p: string): string => `${endpoint.baseUrl}${prefix}${p}`
  const headers = (json: boolean): Record<string, string> => ({
    Authorization: `Bearer ${endpoint.key}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  })

  async function call<T>(
    method: string,
    p: string,
    body?: unknown,
    opts: { timeoutMs?: number; allow404?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T | null> {
    const res = await doFetch(url(p), {
      method,
      headers: { ...headers(body !== undefined), ...opts.headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (opts.allow404 && res.status === 404) return null
    if (!res.ok) throw await errorOf(res)
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  const job = (raw: unknown): HermesJob => {
    const j = (raw as { job?: HermesJob } | null)?.job ?? (raw as HermesJob)
    if (!j || typeof j.id !== 'string')
      throw new HermesApiError('Hermes returned no job', 502, null)
    return j
  }

  return {
    endpoint: { baseUrl: endpoint.baseUrl, profile: endpoint.profile },

    async health(timeoutMs = 2_000) {
      // Unauthenticated on the API server; sent with the key all the same, which
      // it ignores here.
      const res = await doFetch(url('/health'), { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw await errorOf(res)
      return (await res.json()) as { status: string; version?: string }
    },

    async startRun(body, opts = {}) {
      const out = await call<{ run_id?: unknown }>(
        'POST',
        '/v1/runs',
        body,
        opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {},
      )
      const runId = typeof out?.run_id === 'string' ? out.run_id : ''
      if (!runId) throw new HermesApiError('Hermes started no run', 502, null)
      return { runId }
    },

    async getRun(runId) {
      return (await call<HermesRunStatus>('GET', `/v1/runs/${assertId(RUN_ID_RE, runId, 'run')}`))!
    },

    async streamEvents(runId, onEvent, opts = {}) {
      // A stream that stays open but sends nothing is given up, so the caller
      // can read the run again. Any bytes count, Hermes's keepalives included,
      // and the run itself may be quiet for as long as it likes.
      const quiet = new AbortController()
      const idleMs = opts.idleMs ?? STREAM_IDLE_MS
      let idle: ReturnType<typeof setTimeout> | undefined
      const arm = (): void => {
        clearTimeout(idle)
        idle = setTimeout(
          () => quiet.abort(new HermesApiError('The Hermes event stream went quiet', 504, null)),
          idleMs,
        )
        idle.unref?.()
      }
      const signal = opts.signal ? AbortSignal.any([opts.signal, quiet.signal]) : quiet.signal
      arm()
      try {
        const res = await doFetch(url(`/v1/runs/${assertId(RUN_ID_RE, runId, 'run')}/events`), {
          headers: {
            ...headers(false),
            Accept: 'text/event-stream',
            ...(opts.lastSeq !== undefined ? { 'Last-Event-ID': String(opts.lastSeq) } : {}),
          },
          signal,
        })
        if (!res.ok) throw await errorOf(res)
        if (!res.body) return
        await readEvents(res.body as unknown as AsyncIterable<Uint8Array>, onEvent, arm)
      } finally {
        clearTimeout(idle)
      }
    },

    async stopRun(runId) {
      await call('POST', `/v1/runs/${assertId(RUN_ID_RE, runId, 'run')}/stop`)
    },

    async steer(runId, text) {
      await call('POST', `/v1/runs/${assertId(RUN_ID_RE, runId, 'run')}/steer`, { input: text })
    },

    async answerApproval(runId, answer) {
      await call('POST', `/v1/runs/${assertId(RUN_ID_RE, runId, 'run')}/approval`, {
        request_id: answer.requestId,
        execution_generation: answer.executionGeneration,
        choice: answer.choice,
      })
    },

    async listJobs() {
      const out = await call<{ jobs?: HermesJob[] }>('GET', '/api/jobs?include_disabled=true')
      return Array.isArray(out?.jobs) ? out.jobs.filter((j) => typeof j?.id === 'string') : []
    },

    async getJob(id) {
      return job(await call('GET', `/api/jobs/${assertId(JOB_ID_RE, id, 'job')}`))
    },

    async createJob(spec) {
      return job(await call('POST', '/api/jobs', { ...spec, deliver: 'local' }))
    },

    async updateJob(id, patch) {
      const out = await call('PATCH', `/api/jobs/${assertId(JOB_ID_RE, id, 'job')}`, patch)
      return out ? job(out) : null
    },

    async deleteJob(id) {
      await call('DELETE', `/api/jobs/${assertId(JOB_ID_RE, id, 'job')}`)
    },

    async pauseJob(id) {
      await call('POST', `/api/jobs/${assertId(JOB_ID_RE, id, 'job')}/pause`)
    },

    async resumeJob(id) {
      await call('POST', `/api/jobs/${assertId(JOB_ID_RE, id, 'job')}/resume`)
    },

    async runJob(id) {
      await call('POST', `/api/jobs/${assertId(JOB_ID_RE, id, 'job')}/run`)
    },
  }
}
