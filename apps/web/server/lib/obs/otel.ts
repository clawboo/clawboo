// The LAZY OpenTelemetry bridge. The OTel SDK is `await import()`-ed exactly once,
// and ONLY when an OTLP endpoint is configured — so a no-collector boot never
// requires @opentelemetry/* (the same
// lazy-import contract as the Claude Agent SDK in server/lib/runtimes). The whole
// init is try/caught: if the SDK isn't installed (e.g. a lean bundled CLI) the
// bridge degrades to event-log-only — the orchestration_events table is the
// always-on local trace store; OTLP→Jaeger/Zipkin is the opt-in bonus.
//
// Every run of one MISSION shares a deterministic OTel traceId (derived from the
// mission-root id); a child run nests under its parent run's span via the parent
// context the caller resolves from the board ancestor chain (see ./ids), so a
// multi-run task renders as one nested Jaeger trace. The dynamic imports cross a
// single `any` boundary — the bridge is intentionally decoupled from OTel's deep types.

import { otlpConfigured } from './obsFlags'

export interface ObsSpan {
  end(): void
  setError(message: string): void
}

/** The resolved OTel parent for a run span: a hex traceId + the parent run's hex
 *  span id (the board ancestor chain provides these — see ./ids). */
export interface ObsParent {
  traceId: string
  spanId: string
}

export interface ObsTracer {
  /** Open a run span under the given parent context and run `fn` in its context. */
  startActiveSpan<T>(name: string, parent: ObsParent, fn: (span: ObsSpan) => Promise<T>): Promise<T>
  /** Record a zero-duration child span (a tool call) under the active run span. */
  recordChildSpan(name: string, ok: boolean): void
}

let initStarted = false
let tracer: ObsTracer | null = null
let sdkRef: { shutdown?: () => Promise<unknown> } | null = null

/** Why the exporter is not running although an endpoint is set. */
export type OtelInitFailure = 'sdk-missing' | 'init-failed'
let initFailure: OtelInitFailure | null = null

/** A failed `import()` of the SDK means it is not installed (the npm package does
 *  not ship it); anything else is the SDK itself failing to start. */
export function classifyOtelInitError(err: unknown): OtelInitFailure {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
    ? 'sdk-missing'
    : 'init-failed'
}

export async function initOtel(): Promise<void> {
  if (initStarted) return
  initStarted = true
  if (!otlpConfigured()) return
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    // sdk-node re-exports the `api` namespace, so we avoid a direct
    // @opentelemetry/api dependency — declaring it at apps/web's top level would
    // make drizzle-orm pick it up as an OPTIONAL peer and duplicate the instance.
    const sdkMod = (await import('@opentelemetry/sdk-node')) as any
    const expMod = (await import('@opentelemetry/exporter-trace-otlp-http')) as any
    const api = sdkMod.api
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const sdk = new sdkMod.NodeSDK({
      serviceName: process.env['OTEL_SERVICE_NAME'] || 'clawboo',
      traceExporter: new expMod.OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT
    })
    sdk.start()
    sdkRef = sdk as { shutdown?: () => Promise<unknown> }

    const otelTracer = api.trace.getTracer('clawboo')
    const ERROR: number = api.SpanStatusCode?.ERROR ?? 2
    const SAMPLED: number = api.TraceFlags?.SAMPLED ?? 1

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrap = (span: any): ObsSpan => ({
      end: () => span.end(),
      setError: (message: string) => span.setStatus({ code: ERROR, message }),
    })

    tracer = {
      startActiveSpan: <T>(
        name: string,
        parent: ObsParent,
        fn: (span: ObsSpan) => Promise<T>,
      ): Promise<T> => {
        // Pin the run span under its resolved parent context (the parent run's
        // span, or the synthetic mission root for a top-level run) so a multi-run
        // task nests as one trace in Jaeger.
        const parentCtx = api.trace.setSpanContext(api.context.active(), {
          traceId: parent.traceId,
          spanId: parent.spanId,
          traceFlags: SAMPLED,
          isRemote: true,
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return otelTracer.startActiveSpan(name, {}, parentCtx, (span: any) =>
          fn(wrap(span)),
        ) as Promise<T>
      },
      recordChildSpan: (name, ok) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          otelTracer.startActiveSpan(name, (span: any) => {
            if (!ok) span.setStatus({ code: ERROR })
            span.end()
          })
        } catch {
          /* best-effort */
        }
      },
    }

    // A server that stops is flushed by `shutdownOtel`, from its graceful stop.
    // This covers a process that simply runs out of work (a script).
    process.once('beforeExit', () => {
      void sdkRef?.shutdown?.().catch(() => {})
    })
  } catch (err) {
    // SDK absent (lean bundled CLI) or init failed → event-log-only.
    tracer = null
    initFailure = classifyOtelInitError(err)
  }
}

/** How long a stop of the server waits for the trace exporter to flush. */
export const OTEL_SHUTDOWN_WAIT_MS = 2_000

/**
 * Flush and stop the trace exporter, for a stop of the server, waiting at most
 * `waitMs` (an unreachable collector would otherwise hold the stop for the
 * exporter's own 10 s timeout). Called by the server's graceful stop, not from
 * a SIGTERM listener of its own: that one never ran on Ctrl+C, and was not
 * awaited before the process exited. Nothing when the exporter never started.
 * Never rejects.
 */
export async function shutdownOtel(waitMs: number = OTEL_SHUTDOWN_WAIT_MS): Promise<void> {
  const sdk = sdkRef
  if (!sdk?.shutdown) return
  sdkRef = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sdk.shutdown().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function getObsTracer(): ObsTracer | null {
  return tracer
}

/** Set only after `initOtel` ran with an endpoint configured and did not start. */
export function getOtelInitFailure(): OtelInitFailure | null {
  return initFailure
}
