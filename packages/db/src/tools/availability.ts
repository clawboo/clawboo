// ─── Availability gating ────────────────────────────────────────────────────
// Resolve a descriptor's declarative `availability` into visible/hidden. A
// hidden tool is omitted from the model's tools/list (so it can't hallucinate an
// unavailable tool); diagnostics explain WHY (surfaced as the greyed-node
// tooltip in the UI).

import type {
  AvailabilityContext,
  AvailabilityRequirement,
  AvailabilityResult,
  ToolDescriptor,
} from './types'

export interface DefaultAvailabilityOpts {
  /** Provider ids considered authed (e.g. ['openai']). */
  authProviders?: Iterable<string>
  /** Present config paths. */
  config?: Iterable<string>
  /** Enabled plugin ids. */
  plugins?: Iterable<string>
  /** Override env lookup (defaults to process.env). */
  env?: Record<string, string | undefined>
}

/**
 * Build an AvailabilityContext. Env defaults to process.env; auth defaults to
 * checking `${PROVIDER}_API_KEY` in env PLUS any explicit `authProviders`.
 */
export function defaultAvailabilityContext(
  opts: DefaultAvailabilityOpts = {},
): AvailabilityContext {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const authSet = new Set([...(opts.authProviders ?? [])].map((p) => p.toLowerCase()))
  const configSet = new Set(opts.config ?? [])
  const pluginSet = new Set(opts.plugins ?? [])
  return {
    hasEnv: (name) => typeof env[name] === 'string' && env[name]!.length > 0,
    hasAuth: (provider) => {
      const p = provider.toLowerCase()
      if (authSet.has(p)) return true
      const key = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
      return typeof env[key] === 'string' && env[key]!.length > 0
    },
    hasConfig: (path) => configSet.has(path),
    hasPlugin: (id) => pluginSet.has(id),
  }
}

function evalReq(req: AvailabilityRequirement, ctx: AvailabilityContext, diag: string[]): boolean {
  if ('auth' in req) {
    const ok = ctx.hasAuth(req.auth)
    if (!ok) diag.push(`auth-missing:${req.auth}`)
    return ok
  }
  if ('config' in req) {
    const ok = ctx.hasConfig(req.config)
    if (!ok) diag.push(`config-missing:${req.config}`)
    return ok
  }
  if ('env' in req) {
    const ok = ctx.hasEnv(req.env)
    if (!ok) diag.push(`env-missing:${req.env}`)
    return ok
  }
  if ('plugin' in req) {
    const ok = ctx.hasPlugin(req.plugin)
    if (!ok) diag.push(`plugin-disabled:${req.plugin}`)
    return ok
  }
  if ('allOf' in req) {
    // Evaluate all so every unmet sub-requirement is reported.
    return req.allOf.map((r) => evalReq(r, ctx, diag)).every(Boolean)
  }
  if ('anyOf' in req) {
    const sub: string[] = []
    const ok = req.anyOf.map((r) => evalReq(r, ctx, sub)).some(Boolean)
    if (!ok) diag.push(...sub)
    return ok
  }
  return true
}

/** Evaluate availability; visible=true when there's no requirement or it's met. */
export function evaluateAvailability(
  descriptor: ToolDescriptor,
  ctx: AvailabilityContext,
): AvailabilityResult {
  if (!descriptor.availability) return { visible: true, diagnostics: [] }
  const diagnostics: string[] = []
  const visible = evalReq(descriptor.availability, ctx, diagnostics)
  return { visible, diagnostics: visible ? [] : diagnostics }
}
