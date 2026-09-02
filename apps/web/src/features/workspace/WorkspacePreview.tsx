// The rendered artifact, beside the diff that produced it.
//
// The tree and the diff answer "what changed"; this answers "what does it look
// like now". It is an iframe over `GET /api/board/:taskId/preview`, which serves
// static files straight out of the task worktree.
//
// Same-origin on purpose. The access gate's cookie is host-only and
// `SameSite=Lax`, so a separate proxy origin would receive no cookie and 401 on
// every asset. Same-origin also means the frame is only as trusted as the
// dashboard itself, which is why the server pins a content-type allowlist and
// `nosniff` rather than letting an agent-authored file pick its own handler.
//
// Probed before mounting rather than mounted-and-hidden-on-error: an iframe
// pointed at a 404 renders the JSON error body, which looks like a broken
// preview instead of an honest "nothing built yet".

import { useCallback, useEffect, useState } from 'react'
import { apiFetch, apiUrl } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

/** The worktree changes under a running agent; re-probe so a preview appears
 *  once the agent writes an index, without the reader reopening the drawer. */
const PROBE_MS = 10_000

type Probe = 'checking' | 'present' | 'absent'

/** Trailing slash on purpose: the previewed page's own relative asset paths
 *  resolve against this URL, and without it every one of them lands outside the
 *  preview route. The server also redirects to add it, but going straight there
 *  saves the round trip. */
function previewPath(taskId: string): string {
  return `/api/board/${encodeURIComponent(taskId)}/preview/`
}

export function WorkspacePreview({ taskId }: { taskId: string }) {
  const [probe, setProbe] = useState<Probe>('checking')
  // Bumped on every successful probe so the iframe re-fetches. `key` rather than
  // a query string: a cache-busting param would be visible in the previewed
  // page's own URL bar and confuse a relative-path build.
  const [generation, setGeneration] = useState(0)

  const check = useCallback(() => {
    void apiFetch(previewPath(taskId))
      .then((r) => {
        setProbe(r.ok ? 'present' : 'absent')
        if (r.ok) setGeneration((n) => n + 1)
      })
      .catch(() => setProbe('absent'))
  }, [taskId])

  useEffect(() => {
    setProbe('checking')
    check()
  }, [check])
  useVisiblePolling(check, PROBE_MS)

  if (probe === 'checking') return null
  if (probe === 'absent') {
    return (
      <div className="mt-3 rounded border border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground">
        Nothing to preview yet. This shows the workspace&apos;s <code>index.html</code> once the
        agent writes one.
      </div>
    )
  }

  return (
    <div className="mt-3 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Preview
        </span>
        <a
          href={apiUrl(previewPath(taskId))}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Open
        </a>
      </div>
      <iframe
        key={generation}
        title="Workspace preview"
        src={apiUrl(previewPath(taskId))}
        // `allow-same-origin` WITHOUT `allow-scripts`, which reads backwards and
        // is the safer of the two options here.
        //
        // `allow-scripts` alone gives the frame an OPAQUE origin, so every asset
        // it requests carries `Origin: null` — which clawboo's origin guard
        // rejects by design. The preview must stay under `/api/` (that is what
        // the origin guard and the access gate cover), so an opaque origin means
        // the page loads but renders unstyled, with every stylesheet and image
        // 403'd.
        //
        // Granting same-origin is only dangerous to the extent that SCRIPT can
        // use it, and scripts are exactly what stays denied. Everything else the
        // sandbox withholds by default — forms, popups, top-level navigation,
        // downloads, pointer lock — stays withheld. So the agent-authored page
        // gets to look right and can do nothing.
        //
        // The cost is honest and bounded: a JS-driven app previews as its static
        // shell. That matches what this route is — a static file server, not a
        // dev server.
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        className="h-[360px] w-full rounded border border-border bg-white"
      />
    </div>
  )
}
