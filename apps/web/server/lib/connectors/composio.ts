// Composio, through the surface Composio tells applications to use.
//
// THE PREVIOUS ATTEMPT USED THE WRONG DOOR, and every defect in that version
// came from it. It attached to https://connect.composio.dev/mcp, which is the
// endpoint meant for MCP clients like Claude Desktop, and then tried to run
// product features by calling the LLM-facing meta-tools and reading their
// free-text answers. That is why it grew a JSON Schema sniffer, a status-string
// parser, a retry ladder and a third loading state: all of it existed to
// recover typed facts from prose. Composio's own documentation points
// applications at the API instead, and their own reference app does the whole
// integration in a few hundred lines because a typed answer needs no recovery.
//
// ONE KEY, HELD IN THE VAULT, NEVER RETURNED. The key authorises clawboo to
// Composio; the per-app grants live at Composio and clawboo never sees them.
// `hasComposioKey` is the only thing any HTTP response is allowed to learn.

import Composio from '@composio/client'

import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  hasRuntimeSecret,
  setRuntimeSecret,
} from '../secretsVault'
import { isTransient, retryTransient } from './transientRetry'

/** The vault slot. Named like the env var an operator would recognise. */
const KEY_SLOT = 'COMPOSIO_API_KEY'

/**
 * How long any one call may take before it counts as a failure.
 *
 * THE SDK'S DEFAULTS ARE SIZED FOR A BATCH JOB, not for a request someone is
 * waiting on: sixty seconds with two retries is three minutes, and the shelf's
 * status read awaits exactly that call, so a dead network would hold the panel
 * open for the whole of it. Ten seconds and one retry is longer than this read
 * has ever legitimately taken and short enough to fail while the operator is
 * still looking at the screen.
 */
const LIMITS = { timeout: 10_000, maxRetries: 1 } as const

/**
 * Whether a usable key is stored. The ONLY fact about it that may cross an API
 * boundary.
 *
 * READABLE, NOT MERELY PRESENT. The vault's presence check does not decrypt, so
 * an entry left behind by a rotated or lost master key answered yes here while
 * every call behind it found nothing and failed with an internal `no-key`
 * string. Deciding it once, here, keeps that state out of the rest of the code.
 */
export function hasComposioKey(): boolean {
  return hasRuntimeSecret(KEY_SLOT) && getRuntimeSecret(KEY_SLOT) !== null
}

export function setComposioKey(apiKey: string): void {
  setRuntimeSecret(KEY_SLOT, apiKey)
}

export function clearComposioKey(): void {
  deleteRuntimeSecret(KEY_SLOT)
}

/** What a key turned out to be worth, once something actually used it. */
export type KeyVerdict = 'ok' | 'rejected' | 'unreachable'

/**
 * Ask Composio whether this key works, before anything depends on it.
 *
 * THE ONLY HONEST TIME TO ASK IS AT THE POINT OF PASTING. A key that is merely
 * stored looks identical to one that works, so the previous version reported a
 * saved key, an empty app list and no error at all, and the first thing to
 * mention the 401 was a toast on a Connect button several screens later. One
 * cheap request here moves that answer to the moment the person can still fix
 * it, with the key still on their clipboard.
 *
 * UNREACHABLE IS NOT REJECTED. A laptop with no network would otherwise be told
 * its perfectly good key was refused, which sends it back to the dashboard to
 * mint a replacement that fails in exactly the same way.
 */
export async function verifyComposioKey(apiKey: string): Promise<KeyVerdict> {
  try {
    // The narrowest call the API offers. It is a read, so a retry is safe, and
    // one page of one item is enough to prove the key authenticates.
    await new Composio({ apiKey, ...LIMITS }).connectedAccounts.list({ limit: 1 })
    return 'ok'
  } catch (err) {
    const status = statusOf(err)
    if (status === 401 || status === 403) return 'rejected'
    // A 5xx is Composio failing, not the key answering, so it proves nothing
    // either way and must not be reported to the operator as verified.
    if (status === null || status >= 500) return 'unreachable'
    // A 4xx that is not an auth refusal got past authentication, which is the
    // only thing this call set out to establish.
    return 'ok'
  }
}

/**
 * A client, or null when no key is stored.
 *
 * Null rather than throwing, because "no key yet" is the ordinary first state
 * of this feature rather than a fault, and every caller has something sensible
 * to render for it.
 */
function client(): Composio | null {
  const apiKey = getRuntimeSecret(KEY_SLOT)
  if (!apiKey) return null
  return new Composio({ apiKey, ...LIMITS })
}

/** One app, as the shelf needs it. */
export interface ComposioApp {
  /** Composio's own toolkit slug, e.g. `gmail`. */
  slug: string
  connected: boolean
}

export interface ComposioResult<T> {
  ok: boolean
  data: T
  /** Present when `ok` is false. Safe to show; never carries the key. */
  error?: string
}

/**
 * Which toolkits have a usable connected account.
 *
 * ONE CALL FOR ALL OF THEM. The previous version asked per app, which was
 * forty-one sequential round trips on a page load. Composio's list endpoint
 * takes the whole set, and the answer is typed rather than parsed out of a
 * sentence.
 */
export async function listConnectedApps(
  toolkitSlugs: readonly string[],
): Promise<ComposioResult<ReadonlySet<string>>> {
  const composio = client()
  if (!composio) return { ok: false, data: new Set(), error: 'no-key' }
  if (toolkitSlugs.length === 0) return { ok: true, data: new Set() }

  try {
    const res = await composio.connectedAccounts.list({
      toolkit_slugs: [...toolkitSlugs],
      statuses: ['ACTIVE'],
    })
    const connected = new Set<string>()
    for (const item of res.items ?? []) {
      const slug = item.toolkit?.slug
      if (typeof slug === 'string') connected.add(slug.toLowerCase())
    }
    lastVerdict = 'ok'
    return { ok: true, data: connected }
  } catch (err) {
    // A KEY CAN GO BAD AFTER IT WAS GOOD. Verifying at the point of pasting
    // catches a mistyped key; only this catches one that was later rotated or
    // revoked at Composio, which otherwise reads on screen as "no apps are
    // connected" and sends the operator round the connect flow again.
    const status = statusOf(err)
    lastVerdict = status === 401 || status === 403 ? 'rejected' : 'unreachable'

    // NOT AN EMPTY SET. A read that failed must not be reported as "nothing is
    // connected", because the shelf would then offer to connect something that
    // already is, which is the trip back to the provider this replaced.
    return { ok: false, data: new Set(), error: describe(err) }
  }
}

/**
 * Start connecting one app, and return the URL the operator must approve at.
 *
 * The redirect is Composio's hosted consent page. clawboo opens it and nothing
 * more: the provider's tokens are exchanged at Composio and never come here.
 */
export async function authorizeApp(
  toolkitSlug: string,
  userId: string,
): Promise<ComposioResult<{ redirectUrl: string | null }>> {
  const composio = client()
  if (!composio) return { ok: false, data: { redirectUrl: null }, error: 'no-key' }

  try {
    // AN AUTH CONFIG IS REUSED, NOT MINTED PER PRESS. It is Composio's record of
    // how this toolkit is authorised, one per toolkit per project, and creating
    // a second one for every Connect would litter the project with duplicates
    // that all mean the same thing.
    const authConfigId = await ensureAuthConfig(composio, toolkitSlug)
    const redirectUrl = await createAuthLink(authConfigId, userId)
    return { ok: true, data: { redirectUrl } }
  } catch (err) {
    return { ok: false, data: { redirectUrl: null }, error: describe(err) }
  }
}

/**
 * Mint the consent link for one managed auth config.
 *
 * BY HAND, BECAUSE THE PUBLISHED CLIENT CANNOT DO IT. Composio retired
 * `connectedAccounts.create` for Composio-managed OAuth and now answers it with
 * a 400 naming `connected_accounts/link` as the replacement. The client on npm's
 * `latest` tag has no method for that endpoint, and the only versions that do
 * are 2.0 release candidates, so the choice is a release candidate in a shipping
 * dependency or eleven lines of fetch. This is the eleven lines.
 *
 * The rest of the integration stays on the client, so this is the one place that
 * has to be revisited when a stable version catches up.
 */
async function createAuthLink(authConfigId: string, userId: string): Promise<string | null> {
  const apiKey = getRuntimeSecret(KEY_SLOT)
  if (!apiKey) throw new Error('no key')

  const base = process.env['COMPOSIO_BASE_URL'] ?? 'https://backend.composio.dev'
  const res = await retryTransient(() =>
    fetch(`${base}/api/v3.1/connected_accounts/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
    }),
  )

  if (!res.ok) {
    // Thrown rather than returned, so it lands in the one catch that already
    // knows how to turn a failure into words and keep the key out of them.
    const detail = await res.text().catch(() => '')
    throw Object.assign(new Error(`${res.status} ${detail}`), { status: res.status })
  }

  const body = (await res.json()) as { redirect_url?: unknown }
  return typeof body.redirect_url === 'string' ? body.redirect_url : null
}

/** The toolkit's existing auth config, or a newly created managed one. */
async function ensureAuthConfig(composio: Composio, toolkitSlug: string): Promise<string> {
  const existing = await composio.authConfigs.list({ toolkit_slug: toolkitSlug })
  const found = existing.items?.[0]?.id
  if (typeof found === 'string') return found

  // `use_composio_managed_auth` is what makes this work without the operator
  // registering an OAuth application with each provider, which is the entire
  // reason a broker is here at all.
  const made = await composio.authConfigs.create({
    toolkit: { slug: toolkitSlug },
    auth_config: { type: 'use_composio_managed_auth' },
  })
  return made.auth_config.id
}

/**
 * The HTTP status behind a failure, when there was one.
 *
 * Null means the request never got an answer, which is a different thing from
 * being refused and leads somewhere different for the reader.
 */
function statusOf(err: unknown): number | null {
  const direct = (err as { status?: unknown })?.status
  if (typeof direct === 'number') return direct
  const message = err instanceof Error ? err.message : ''
  const leading = message.match(/^(\d{3})\b/)
  return leading?.[1] ? Number(leading[1]) : null
}

/**
 * A failure, in a sentence a person can act on.
 *
 * NOT THE PROVIDER'S OWN WORDS. The SDK reports a refusal as the status code
 * followed by the raw JSON body, which reached the operator as a toast reading
 * `401 {"error":{"message":"Invalid API key: COM**...`. That names no cause and
 * suggests no next step. The cases worth distinguishing are named here and
 * everything else falls back to the scrubbed original, truncated, because an
 * unknown failure still has to say something.
 */
function describe(err: unknown): string {
  const status = statusOf(err)
  if (status === 401 || status === 403) return 'Composio rejected the key.'
  if (status === 429) return 'Composio is rate limiting this key. Try again shortly.'
  if (status !== null && status >= 500) return 'Composio is not responding. Try again shortly.'
  if (isTransient(err)) return 'Could not reach Composio. Check the connection and try again.'

  // The key travels in a header rather than the body, but the client echoes the
  // request in some errors, so the text is scrubbed rather than trusted.
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/\b[u]?ak_[A-Za-z0-9_-]+/g, '[key]').slice(0, 200)
}

// ─── Cached connected set ────────────────────────────────────────────────────
//
// WHY A CACHE AND NOT A READ. Two callers need to know which apps are
// connected: the shelf, once per visit, and the capability projection, which
// runs whenever anything rebuilds the graph. Asking the broker on every
// projection would put a network round trip inside a render path, and the
// previous version's whole visible failure was exactly that: a three second
// read on page load, and a third UI state invented to cover it.
//
// So the cache answers instantly and is refreshed behind the reader. A caller
// that has never been told anything gets `known: false` and can say so; a
// caller after the first refresh gets the last good answer even while a newer
// one is in flight. Nothing waits.

const CACHE_TTL_MS = 60_000

let cached: { connected: ReadonlySet<string>; at: number } | null = null
let inFlight: Promise<void> | null = null

/** What the last call using the stored key found out about it. */
let lastVerdict: KeyVerdict | null = null

/**
 * The stored key's standing, as far as anything has actually tried it.
 *
 * Null before the first attempt. A caller renders "not checked yet" for that
 * rather than guessing, because guessing well is what produced a screen that
 * said nothing was wrong while every call was being refused.
 */
export function composioKeyVerdict(): KeyVerdict | null {
  return lastVerdict
}

/** Record a verdict reached elsewhere, so one paste settles the whole surface. */
export function noteComposioKeyVerdict(verdict: KeyVerdict | null): void {
  lastVerdict = verdict
}

/** The last known connected set, without ever waiting. */
export function connectedAppsNow(): { connected: ReadonlySet<string>; known: boolean } {
  return cached
    ? { connected: cached.connected, known: true }
    : { connected: new Set<string>(), known: false }
}

/**
 * Refresh the cache if it is stale, at most one refresh at a time.
 *
 * Returns when the cache is current, so a caller that genuinely wants to wait
 * can, and `connectedAppsNow` stays available to those that cannot.
 */
export async function refreshConnectedApps(toolkitSlugs: readonly string[]): Promise<void> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return
  if (inFlight) return inFlight
  inFlight = (async () => {
    const res = await listConnectedApps(toolkitSlugs)
    if (res.ok) {
      cached = { connected: res.data, at: Date.now() }
      return
    }
    // A REFUSED KEY IS NOT A BLINK. Nothing behind it is reachable any more, so
    // keeping the last good answer would leave the shelf ticking apps as
    // connected and the graph drawing a node per app, both of them describing
    // access that no longer exists.
    if (lastVerdict === 'rejected') cached = null

    // Otherwise the answer stands. A FAILED READ DOES NOT OVERWRITE A GOOD ONE:
    // reporting an empty set because the network blinked would offer to connect
    // apps that already are, which is the trip back to the provider this
    // rebuild replaced.
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Drop the cache, so the next read reflects a connect that just happened.
 *
 * The verdict goes with it: it described the key in force at the time, and this
 * is also called when that key is replaced or removed.
 */
export function invalidateConnectedApps(): void {
  cached = null
  lastVerdict = null
}
