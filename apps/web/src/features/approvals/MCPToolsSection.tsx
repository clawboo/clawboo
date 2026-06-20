// ─── MCP tools governance ─────────────────────────────────────
// Section appended to the Approvals panel (the MCP surface is always on). Shows
// (1) the pending tool-call / delegation approvals queue (the user resolves them
// — extracted into <ToolApprovalQueue/> so the Governance dashboard reuses the
// SAME resolve UX), and (2) the broker's tools with their AVAILABILITY
// (unavailable = greyed + a diagnostics tooltip — the "greyed in UI" surface for
// the brokered-tool model, distinct from the Ghost Graph's per-agent skills).

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'

import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill } from '@/features/shared/StatusPill'
import { ENTER_SPRING, listDelay } from '@/lib/motion'

import { ToolApprovalQueue } from './ToolApprovalQueue'

interface ToolInfo {
  name: string
  description: string
  owner: string
  risk: string
  available: boolean
  diagnostics: string[]
}

const KICKER: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgb(var(--foreground-rgb) / 0.4)',
  fontFamily: 'var(--font-mono)',
  margin: '4px 0',
}

export function MCPToolsSection() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const t = await fetch('/api/tools').then((r) => (r.ok ? r.json() : { tools: [] }))
      setTools((t as { tools?: ToolInfo[] }).tools ?? [])
    } catch {
      /* best-effort */
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refetch()
    const id = setInterval(() => void refetch(), 3000)
    return () => clearInterval(id)
  }, [refetch])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Pending tool-call / delegation approvals (shared queue) */}
      <ToolApprovalQueue />

      {/* Tool availability (greyed when an availability requirement is unmet).
          During the first fetch a skeleton stands in; a genuinely-empty broker
          stays silent (the queue above already carries the panel). */}
      {!loaded ? (
        <>
          <div style={KICKER}>Tools</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={38} radius={9} />
            ))}
          </div>
        </>
      ) : tools.length > 0 ? (
        <>
          <div style={KICKER}>Tools</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tools.map((t, i) => (
              <motion.div
                key={t.name}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                className="surface-raised-tier"
                title={t.available ? t.description : `Unavailable — ${t.diagnostics.join(', ')}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderRadius: 9,
                  padding: '8px 11px',
                  opacity: t.available ? 1 : 0.6,
                }}
              >
                <span
                  className="font-data"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--foreground)',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t.name}
                </span>
                {t.risk !== 'safe' && (
                  <span
                    title={`risk: ${t.risk}`}
                    style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--amber)' }}
                  >
                    <AlertTriangle size={13} />
                  </span>
                )}
                <StatusPill
                  tone={t.available ? 'success' : 'idle'}
                  label={t.available ? 'Available' : 'Unavailable'}
                />
              </motion.div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
