// Pure, deterministic id helpers for the obs trace layer. A mission's runs share
// a traceId derived from the mission-root task id; each run's span id is derived
// from its OWN task id and its parent span id from its PARENT task id — so the
// board ancestor chain IS the trace hierarchy (a child task's run nests under its
// parent task's run) with no context threading. `formatTraceparent` /
// `parseTraceparent` are the W3C bridge for cross-process chaining.

import { createHash } from 'node:crypto'

/** Deterministic hex id of `bytes` length from an arbitrary string (OTel ids are hex). */
export function hexId(input: string, bytes: number): string {
  return createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, bytes * 2)
}

/** The 16-byte (32-hex) trace id shared by every run of one mission (its root task id). */
export function traceIdFor(missionRoot: string): string {
  return hexId(missionRoot, 16)
}

/** The 8-byte (16-hex) span id for one run, derived from its task id. */
export function spanIdFor(taskId: string): string {
  return hexId(taskId, 8)
}

/** The synthetic mission-root span id — the parent of a top-level run. */
export function rootSpanIdFor(missionRoot: string): string {
  return hexId(`${missionRoot}:root`, 8)
}

/** A W3C `traceparent` header value for (traceId, spanId), sampled. */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

/** Parse a W3C `traceparent`; null if malformed. (Structured-format parse, not
 *  prose scraping — the ids never carry orchestration state.) */
export function parseTraceparent(
  tp: string | null | undefined,
): { traceId: string; spanId: string } | null {
  if (!tp) return null
  const m = TRACEPARENT_RE.exec(tp.trim())
  if (!m) return null
  const [, traceId, spanId] = m
  if (!traceId || !spanId) return null
  return { traceId, spanId }
}
