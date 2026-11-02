// "Who can use it?" on a connected connector's page.
//
// Connecting a connector gives it to nobody: an agent can use it only once it
// holds a grant. Before this, the only way to grant was to draw an edge on the
// Org chart, which nothing on the connector page mentioned, so a connector read
// as connected while no agent could call it. This lists the agents, shows who
// already has access, and grants the ones picked (write access, risky calls
// ask first, the same grant a thread drawn on the graph makes).
//
// When the page was opened from an agent's "ask for a connector" card, that
// agent is preselected, and it is given access as soon as the connector comes
// up, by whichever path connected it. Not when it already has a grant row:
// a revoked one means a person took access away, and an agent asking again
// must not undo that. It stays preselected, one click from Give access.
// OpenClaw agents are never preselected or granted: a grant cannot reach them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'
import type { ConnectorDefinition } from '@clawboo/connector-catalog'

import { Button } from '@/features/shared/Button'
import { grantConnectorToAgent } from '@/features/graph/operations/grantConnector'
import { useFleetStore } from '@/stores/fleet'

import { listLiveConnectors } from './connectConnector'

interface GrantLite {
  subjectKind: string
  subjectId: string | null
  connectorId: string | null
  revokedAt: number | null
}

/** OpenClaw agents call Clawboo's tools without an agent identity, so a grant
 *  made for one of them never reaches it (see the connectors docs). */
const isOpenClaw = (runtime: string | null | undefined): boolean =>
  runtime == null || runtime === 'openclaw'

interface AccessRows {
  /** Agents holding a live grant on this connector. */
  active: Set<string>
  /** Agents with a grant row of any kind, revoked included. */
  anyRow: Set<string>
}

async function accessRows(connectorId: string): Promise<AccessRows> {
  const empty = { active: new Set<string>(), anyRow: new Set<string>() }
  try {
    const res = await apiFetch('/api/grants')
    if (!res.ok) return empty
    const body = (await res.json()) as { grants?: GrantLite[] }
    const mine = (body.grants ?? []).filter(
      (g) => g.connectorId === connectorId && g.subjectKind === 'agent' && g.subjectId,
    )
    return {
      active: new Set(mine.filter((g) => g.revokedAt == null).map((g) => g.subjectId as string)),
      anyRow: new Set(mine.map((g) => g.subjectId as string)),
    }
  } catch {
    return empty
  }
}

export function ConnectorAccessPicker({
  def,
  connected,
  askFor,
}: {
  def: ConnectorDefinition
  connected: boolean
  /** The agent whose ask card opened this page, if any. */
  askFor: { agentId: string; agentName: string } | null
}) {
  const agents = useFleetStore((s) => s.agents)
  const [connectorId, setConnectorId] = useState<string | null>(null)
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [revoked, setRevoked] = useState<Set<string>>(new Set())
  // The asker starts picked, unless it is an OpenClaw agent: a grant never
  // reaches one, and its box is disabled, so it must not ride along on Give access.
  const [picked, setPicked] = useState<Set<string>>(() => {
    if (!askFor) return new Set()
    const asker = useFleetStore.getState().agents.find((a) => a.id === askFor.agentId)
    return asker && isOpenClaw(asker.runtime) ? new Set() : new Set([askFor.agentId])
  })
  const [busy, setBusy] = useState(false)
  const autoGranted = useRef(false)

  const reload = useCallback(async (): Promise<string | null> => {
    const row = (await listLiveConnectors()).find((r) => r.slug === def.slug) ?? null
    setConnectorId(row?.connectorId ?? null)
    const rows = row ? await accessRows(row.connectorId) : null
    setGranted(rows?.active ?? new Set())
    setRevoked(new Set([...(rows?.anyRow ?? [])].filter((id) => !(rows?.active.has(id) ?? false))))
    return row?.connectorId ?? null
  }, [def.slug])

  useEffect(() => {
    if (!connected) {
      setConnectorId(null)
      return
    }
    let cancelled = false
    void (async () => {
      const id = await reload()
      if (cancelled || !id || !askFor || autoGranted.current) return
      // THE AGENT THAT ASKED GETS IT, once. Connecting from its card used to
      // grant nobody, so the agent asked, the person connected, and the agent
      // still could not call a single tool.
      autoGranted.current = true
      // ANY ROW, REVOKED INCLUDED, STOPS IT. Re-sharing reactivates a revoked
      // grant, so granting here would quietly undo a person taking access away,
      // on nothing but the agent asking again. The asker stays preselected and
      // Give access is one click.
      const rows = await accessRows(id)
      if (rows.anyRow.has(askFor.agentId)) return
      const agent = useFleetStore.getState().agents.find((a) => a.id === askFor.agentId)
      if (agent && isOpenClaw(agent.runtime)) return
      const ok = await grantConnectorToAgent(
        {
          targetAgentId: askFor.agentId,
          connectorId: id,
          capabilityId: null,
          mode: 'write',
          approvalPolicy: 'risk',
        },
        { connectorName: def.displayName, targetAgentName: askFor.agentName },
      )
      if (ok && !cancelled) await reload()
    })()
    return () => {
      cancelled = true
    }
  }, [connected, askFor, def.displayName, reload])

  const rows = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents])

  if (!connected || !connectorId) return null

  const toGrant = [...picked].filter((id) => {
    const agent = agents.find((a) => a.id === id)
    return !granted.has(id) && !(agent && isOpenClaw(agent.runtime))
  })

  const give = async (): Promise<void> => {
    setBusy(true)
    try {
      for (const id of toGrant) {
        const agent = agents.find((a) => a.id === id)
        await grantConnectorToAgent(
          {
            targetAgentId: id,
            connectorId,
            capabilityId: null,
            mode: 'write',
            approvalPolicy: 'risk',
          },
          { connectorName: def.displayName, targetAgentName: agent?.name ?? id },
        )
      }
      setPicked(new Set())
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby={`access-${def.slug}`}
      data-testid="connector-access-picker"
      className="rounded-xl border border-border bg-surface-subtle p-4"
    >
      <h3
        id={`access-${def.slug}`}
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Who can use it?
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Connecting gives it to nobody. Pick the agents that may call its tools. They get write
        access, and anything risky asks you first.
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-foreground">No agents yet.</p>
      ) : (
        <ul className="mt-2 flex max-h-[220px] flex-col gap-0.5 overflow-y-auto">
          {rows.map((a) => {
            const has = granted.has(a.id)
            const openClaw = isOpenClaw(a.runtime)
            return (
              <li key={a.id}>
                <label
                  className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-xs ${
                    has || openClaw ? 'text-muted-foreground' : 'cursor-pointer text-foreground'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={has || picked.has(a.id)}
                    disabled={has || openClaw || busy}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(a.id)
                        else next.delete(a.id)
                        return next
                      })
                    }
                  />
                  <span>{a.name}</span>
                  {has && <span className="text-[11px]">Has access</span>}
                  {!has && openClaw && (
                    <span className="text-[11px]">
                      OpenClaw agents cannot use shared connectors
                    </span>
                  )}
                  {!has && !openClaw && revoked.has(a.id) && (
                    <span className="text-[11px]">Access taken back</span>
                  )}
                  {!has && !openClaw && askFor?.agentId === a.id && (
                    <span className="text-[11px]">Asked for it</span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-2.5">
        <Button
          size="sm"
          variant="primary"
          disabled={toGrant.length === 0 || busy}
          loading={busy}
          onClick={() => void give()}
        >
          Give access
        </Button>
      </div>
    </section>
  )
}
