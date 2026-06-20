// Pure scheduler display/intent helpers, extracted from SchedulerPanel so the
// one-shot label case and the own-life predicate are directly unit-testable in
// the node test project (no React import).

import { decodeCronSpec, isOnceSpec, ONCE_PREFIX } from '@clawboo/scheduler'

/**
 * Human-friendly label for a schedule's cron spec — handles BOTH source
 * dialects: the gateway `every:`/`at:`/cron forms (via decodeCronSpec) and the
 * routine one-shot `once@<ISO>`. The one-shot is checked FIRST because
 * decodeCronSpec would otherwise treat `once@…` as a raw (ugly) cron expression.
 * Preset labels are applied by the caller, not here.
 */
export function formatScheduleLabel(spec: string): string {
  // Routine one-shot → `once · <ISO>` (mirrors the gateway `at` one-shot form).
  if (isOnceSpec(spec)) {
    const iso = spec.trim().slice(ONCE_PREFIX.length)
    return Number.isNaN(Date.parse(iso)) ? spec : `once · ${iso}`
  }
  const s = decodeCronSpec(spec)
  if (s.kind === 'every') {
    const ms = s.everyMs
    if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d`
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`
    if (ms % 60_000 === 0) return `every ${ms / 60_000}m`
    return `every ${Math.round(ms / 1000)}s`
  }
  if (s.kind === 'at') return `once · ${s.at}`
  return s.expr
}

/**
 * Only a genuine OpenClaw agent may be scheduled for its OWN LIFE (a Gateway
 * cron job). A null/unknown/non-OpenClaw runtime must never be offered that
 * intent — so this is a strict positive match, never a `?? 'openclaw'` default.
 */
export function canScheduleOwnLife(runtime: string | null | undefined): boolean {
  return runtime === 'openclaw'
}
