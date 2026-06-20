// Observability config predicate. `otlpConfigured()` gates the live OTel bridge —
// the SDK is lazy-imported only when an OTLP endpoint is configured, so a
// no-collector boot never requires @opentelemetry/*.

export function otlpConfigured(): boolean {
  return Boolean(
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] || process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
  )
}
