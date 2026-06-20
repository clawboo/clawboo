// Server-side observability lib. The pure schemas/reducers/taxonomy live in
// @clawboo/obs; this layer does the I/O: emit events to the durable log, open
// task/tool spans (event-log + lazy OTLP), and structured logging.
export { otlpConfigured } from './obsFlags'
export { emitEvent } from './emit'
export { withTaskSpan, recordToolSpan, type SpanCtx, type TaskSpanMeta } from './tracing'
export { initOtel, getObsTracer, type ObsSpan, type ObsTracer, type ObsParent } from './otel'
export {
  hexId,
  traceIdFor,
  spanIdFor,
  rootSpanIdFor,
  formatTraceparent,
  parseTraceparent,
} from './ids'
export { logStructured, alertHarnessBug } from './logger'
