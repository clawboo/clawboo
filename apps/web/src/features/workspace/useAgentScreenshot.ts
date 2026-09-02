// The newest frame an agent captured, and when.
//
// Extracted so the two surfaces that show it can look completely different
// without duplicating the fetch: the agent-detail tab renders a labelled panel
// that fills its pane, the graph dock renders the bare screen. Both must agree
// on what "the latest frame" is, and the only way to guarantee that is one
// source of truth for the probe.
//
// Only the METADATA is fetched. The image itself is loaded by the `<img>` the
// caller renders, so a poll that finds nothing new costs a few bytes rather
// than a screenshot.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch, apiUrl } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

/** Fast enough to feel live while an agent works, slow enough not to hammer a
 *  route that decodes base64 on every call. */
const POLL_MS = 3_000

export interface ScreenshotMeta {
  mimeType: string
  toolName: string
  ts: number
}

export interface AgentScreenshot {
  /** null once checked and the agent has captured nothing. */
  meta: ScreenshotMeta | null
  /** False until the first probe answers — lets a caller reserve space rather
   *  than flashing an empty state it is about to replace. */
  checked: boolean
  /** Cache-busted URL for the current frame, or null. The route always serves
   *  "the latest", so the timestamp is what makes a NEW frame a new URL. */
  src: string | null
}

export function useAgentScreenshot(agentId: string | null, enabled = true): AgentScreenshot {
  const [meta, setMeta] = useState<ScreenshotMeta | null>(null)
  const [checked, setChecked] = useState(false)

  const check = useCallback(() => {
    if (!agentId || !enabled) return
    void apiFetch(`/api/agents/${encodeURIComponent(agentId)}/screenshot?meta=1`)
      .then(async (r) => {
        setChecked(true)
        if (!r.ok) {
          setMeta(null)
          return
        }
        const body = (await r.json()) as { mimeType?: string; toolName?: string; ts?: number }
        if (typeof body.ts !== 'number') return
        setMeta({
          mimeType: body.mimeType ?? 'image/png',
          toolName: body.toolName ?? 'unknown',
          ts: body.ts,
        })
      })
      .catch(() => setChecked(true))
  }, [agentId, enabled])

  useEffect(() => {
    setMeta(null)
    setChecked(false)
    check()
  }, [check])
  useVisiblePolling(check, POLL_MS)

  return {
    meta,
    checked,
    src:
      agentId && meta
        ? `${apiUrl(`/api/agents/${encodeURIComponent(agentId)}/screenshot`)}?t=${meta.ts}`
        : null,
  }
}
