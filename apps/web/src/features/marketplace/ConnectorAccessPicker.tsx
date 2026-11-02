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
// up, by whichever path connected it.

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

async function agentsWithAccess(connectorId: string): Promise<Set<string>> {
  try {
    const res = await apiFetch('/api/grants')
    if (!res.ok) return new Set()
    const body = (await res.json()) as { grants?: GrantLite[] }
    return new Set(
      (body.grants ?? [])
        .filter(
          (g) =>
            g.connectorId === connectorId &&
            g.subjectKind === 'agent' &&
            g.subjectId &&
            g.revokedAt == null,
        )
        .map((g) => g.subjectId as string),
    )
  } catch {
    return new Set()
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
  const [picked, setPicked] = useState<Set<string>>(() =>
    askFor ? new Set([askFor.agentId]) : new Set(),
  )
  const [busy, setBusy] = useState(false)
  const autoGranted = useRef(false)

  const reload = useCallback(async (): Promise<string | null> => {
    const row = (await listLiveConnectors()).find((r) => r.slug === def.slug) ?? null
    setConnectorId(row?.connectorId ?? null)
    setGranted(row ? await agentsWithAccess(row.connectorId) : new Set())
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
      const has = await agentsWithAccess(id)
      if (has.has(askFor.agentId)) return
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

  const toGrant = [...picked].filter((id) => !granted.has(id))

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
