// Photograph one OpenClaw tab, without ever being the thing that opens a browser.
//
// THE RULE THIS OBEYS is already written down for the native path in
// `api/agents.ts`: "the panel photographs a window that already exists and is
// never the thing that opens one." Applying it to OpenClaw's browser is the whole
// reason this talks to Chrome directly instead of through the Gateway.
//
// The obvious route, the Gateway's `browser.request POST /screenshot`, breaks that
// rule three ways, all of them confirmed in the shipped 2026.9 code:
//   * it calls `ensureBrowserAvailable` unconditionally, so a screenshot taken
//     while the browser is closed puts a real Chrome window on the operator's desk;
//   * when the browser is open but empty it opens `about:blank`;
//   * it moves a `lastTargetId` pointer that is SHARED by every agent on the
//     profile, even when an explicit target was named — so photographing agent A
//     could silently redirect agent B's next browser command to A's page.
// It also writes a file into OpenClaw's own media directory, which has no pruner,
// leaving clawboo to delete another product's files on every frame.
//
// Reading CDP directly avoids all four. `/json/list` is a pure probe that fails
// when Chrome is not running, and attaching to an existing page captures it in the
// background without focusing it or changing any shared state.

import { createLogger } from '@clawboo/logger'
import { WebSocket } from 'ws'

const log = createLogger('openclaw-tab-capture')

/** Long enough for a cold page, short enough that a wedged tab cannot hold a request. */
const CAPTURE_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 1_500

/**
 * The debugging port OpenClaw's managed browser listens on.
 *
 * DERIVED, NOT DISCOVERED, and deliberately so. The Gateway does expose a status
 * call that reports the port, but reaching it means an authenticated operator
 * connection, and this module is meant to work from any clawboo instance without
 * one. OpenClaw derives the default the same way: gateway port, plus 2 for the
 * browser control port, plus 9 for the CDP range start — 18789 -> 18791 -> 18800.
 * An operator who has moved it can say so.
 */
export function openclawCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env['CLAWBOO_OPENCLAW_CDP_PORT'])
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  const gatewayPort = Number(env['OPENCLAW_GATEWAY_PORT']) || 18789
  return gatewayPort + 2 + 9
}

interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/**
 * The pages Chrome currently has open, or null when it is not running.
 *
 * THE LIVENESS GATE. `null` and `[]` mean different things and the caller depends
 * on the difference: null is "no browser at all", empty is "a browser with nothing
 * in it". The panel has to tell "this Boo has no tab" from "this Boo had a tab and
 * it is gone", or it repeats the overstating the `restored` flag was added to fix.
 */
export async function listOpenClawPages(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CdpTarget[] | null> {
  const port = openclawCdpPort(env)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    if (!Array.isArray(body)) return null
    return body.filter(
      (t): t is CdpTarget =>
        !!t && typeof t === 'object' && typeof (t as CdpTarget).id === 'string',
    )
  } catch {
    // Connection refused is the normal "browser is not running" answer, not an error.
    return null
  }
}

/**
 * Capture one page by its CDP target id.
 *
 * Returns base64 with no data: prefix, which is the shape `putScreenshot` takes.
 * Null on any failure, because a panel that cannot show a frame must show its
 * honest empty state rather than an error.
 */
export async function captureOpenClawTab(
  targetId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ data: string; mimeType: string } | null> {
  const pages = await listOpenClawPages(env)
  // Gate on the tab being LIVE. OpenClaw's store outlives the tab: rows are swept
  // on a timer (2 hours idle by default), so a recorded tab is routinely a closed
  // one. Attaching to a dead target would hang until the timeout on every poll.
  const target = pages?.find((p) => p.id === targetId && p.type === 'page')
  if (!target) return null

  const port = openclawCdpPort(env)
  const wsUrl = target.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/devtools/page/${targetId}`

  return await new Promise((resolve) => {
    let settled = false
    const ws = new WebSocket(wsUrl)
    const finish = (value: { data: string; mimeType: string } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // Already closing; nothing to recover.
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS)

    ws.on('open', () => {
      // `Page.enable` first: capture on a page that has never had the domain
      // enabled returns an error on some Chrome builds rather than a frame.
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
      ws.send(
        JSON.stringify({
          id: 2,
          method: 'Page.captureScreenshot',
          // JPEG at a modest quality: the panel shows a thumbnail, and the frame
          // is held in memory and mirrored to disk, so a full-quality PNG per poll
          // per agent is a cost with nothing to show for it.
          params: { format: 'jpeg', quality: 60, captureBeyondViewport: false },
        }),
      )
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { id?: number; result?: { data?: string } }
        if (msg.id !== 2) return
        const data = msg.result?.data
        finish(
          typeof data === 'string' && data.length > 0 ? { data, mimeType: 'image/jpeg' } : null,
        )
      } catch {
        finish(null)
      }
    })

    ws.on('error', (err) => {
      log.debug({ err, targetId }, 'CDP capture failed')
      finish(null)
    })
    ws.on('close', () => finish(null))
  })
}
