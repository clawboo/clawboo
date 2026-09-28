import { useCallback, useMemo, useState } from 'react'
import type { Node, XYPosition } from '@xyflow/react'
import { readAgentFile, writeAgentFile } from '@clawboo/control-client'
import { connectorBySlug } from '@clawboo/connector-catalog'

import { useBrokeredApps } from '@/features/connectors/useBrokeredApps'
import { useConnectorCostState } from '@/features/connectors/useConnectorCostState'
import { BUILTIN_SKILLS } from '@/features/marketplace/catalog'
import { connectConnector, signInConnector } from '@/features/marketplace/connectConnector'
import { mutationQueue } from '@/lib/mutationQueue'

import { connectorSlugFromId } from './nodes/connectorTile'
import { grantConnectorToAgent } from './operations/grantConnector'
import { installSkillForAgent } from './operations/installSkill'
import { withRoutingAppended } from './operations/routingLine'
import { spawnAgent } from './operations/spawnNode'
import { useGraphStore } from './store'
import type { ThreadOption } from './ThreadPicker'
import { threadOptionsFor } from './threadOptions'
import type { GraphNode } from './types'

// ─── The thread ──────────────────────────────────────────────────────────────
//
// What a thread let go on empty canvas can end in, and what picking one does.
// Every canvas that draws a Boo's port mounts this: the Ghost Graph (Atlas and
// a team's graph) and the agent view's mini graph. One hook so a thread pulled
// off the same Boo offers the same rows and does the same thing on each.
//
// What the released thread could end in is recomputed only while a drop is
// pending, so the catalogs are not walked on every render of an idle canvas.

/**
 * Where a thread was released on empty canvas, and what it came from. Held in
 * SCREEN pixels for the picker's placement and in FLOW coordinates for the
 * spawn, because the node has to land where the pointer was regardless of pan
 * or zoom.
 */
export interface ThreadDropState {
  screen: XYPosition
  flow: XYPosition
  fromNodeId: string
  fromNodeType: string | null
}

export interface UseThreadDropOptions {
  nodes: GraphNode[]
  getNode: (id: string) => Node | undefined
  screenToFlowPosition: (point: XYPosition) => XYPosition
  /**
   * Open the source Boo's orbital ring before a new tile is born into it. A
   * canvas whose rings never close (the mini graph) passes nothing.
   */
  expandBoo?: (booNodeId: string) => void
  /** The team a new agent joins when the Boo the thread came from has none. */
  fallbackTeamId: string | null
}

export function useThreadDrop({
  nodes,
  getNode,
  screenToFlowPosition,
  expandBoo,
  fallbackTeamId,
}: UseThreadDropOptions) {
  const [threadDrop, setThreadDrop] = useState<ThreadDropState | null>(null)

  // Prices a connector exactly as the Connectors shelf does, so a row offered
  // here and the same row two clicks away can never disagree.
  const { costOf: connectorCostOf, refresh: refreshConnectorCosts } = useConnectorCostState()
  const { apps: brokeredApps, refresh: refreshBrokeredApps } = useBrokeredApps()

  const threadOptions = useMemo(() => {
    if (!threadDrop) return []
    const sourceAgentId = threadDrop.fromNodeId.startsWith('boo-')
      ? threadDrop.fromNodeId.slice(4)
      : null
    const owned = new Set<string>()
    const live = new Set<string>()
    const held = new Set<string>()
    for (const n of nodes) {
      const d = n.data as { skillId?: string; name?: string; connectorId?: string }
      if (!sourceAgentId) continue
      if (n.type === 'skill' && n.id.startsWith(`skill-${sourceAgentId}-`) && d.name) {
        owned.add(d.name)
      }
      if (n.type === 'resource' && n.id.startsWith(`resource-${sourceAgentId}-`)) {
        const slug = connectorSlugFromId(d.connectorId ?? null)
        if (slug) live.add(slug)
        // An app tile's identity ends in `:app:<toolkit>`, which is what a
        // brokered row is keyed on. Without this the picker keeps offering an
        // app the agent already holds.
        const app = /:app:([^:]+)$/.exec(d.connectorId ?? '')
        if (app?.[1]) held.add(app[1])
      }
    }
    const heldToolkits: ReadonlySet<string> = held
    return threadOptionsFor({
      fromNodeType: threadDrop.fromNodeType,
      ownedSkillNames: owned,
      liveConnectorSlugs: live,
      costOf: (def) => connectorCostOf(def),
      brokeredApps,
      agentToolkits: heldToolkits,
    })
  }, [threadDrop, nodes, connectorCostOf, brokeredApps])

  /** Commit a picked row: create the thing, wired to the source, where it fell. */
  const handleThreadPick = useCallback(
    async (option: ThreadOption) => {
      const drop = threadDrop
      setThreadDrop(null)
      if (!drop) return
      const agentId = drop.fromNodeId.startsWith('boo-') ? drop.fromNodeId.slice(4) : null
      if (!agentId) return
      const agentName =
        (getNode(drop.fromNodeId)?.data as { name?: string } | undefined)?.name ?? 'this agent'

      // AUTO-EXPAND FIRST. The tile is about to be born in the source's orbital
      // ring, and that ring starts collapsed: without this the write succeeds
      // and absolutely nothing changes on screen, which is the single most
      // confusing outcome this surface can produce.
      expandBoo?.(drop.fromNodeId)

      if (option.id.startsWith('skill:')) {
        const skill = BUILTIN_SKILLS.find((s) => `skill:${s.id}` === option.id)
        if (skill) await installSkillForAgent(skill.name, agentId, agentName)
        return
      }
      // An app reached THROUGH a broker. Nothing is connected here: the broker's
      // session already carries it, and the only thing missing is this agent's
      // permission to use that one app.
      if (option.id.startsWith('brokered:')) {
        const toolkit = option.id.slice('brokered:'.length)
        // The base identity comes from the SERVER. It is the one string the
        // browser must not spell for itself: a grant minted under a second
        // spelling is a grant the broker never looks up.
        const session = await connectConnector('composio', 'Composio', undefined, true)
        if (!session) return
        await grantConnectorToAgent(
          {
            targetAgentId: agentId,
            connectorId: `${session.connectorId}:app:${toolkit}`,
            capabilityId: null,
            mode: 'write',
            approvalPolicy: 'risk',
          },
          { connectorName: option.label, targetAgentName: agentName },
        )
        refreshBrokeredApps()
        useGraphStore.getState().triggerRefresh()
        return
      }

      if (option.id.startsWith('connector:')) {
        const slug = option.id.slice('connector:'.length)
        const def = connectorBySlug(slug)
        if (!def) return
        const cost = connectorCostOf(def)
        let connected: Awaited<ReturnType<typeof connectConnector>> = null
        if (cost === 'on') {
          // ALREADY RUNNING, so this press is only about access. The route is
          // idempotent and hands back the connectorId a grant is keyed on, which
          // is the one thing the browser cannot spell for itself: the server owns
          // that identity, and a second spelling here would mint grants under an
          // id the broker never looks up. Quiet, because nothing connected.
          connected = await connectConnector(def.slug, def.displayName, undefined, true)
        } else if (cost === 'one-click') {
          if (await signInConnector(def.slug, def.displayName)) {
            connected = await connectConnector(def.slug, def.displayName)
          }
        } else {
          connected = await connectConnector(def.slug, def.displayName)
        }

        // THE GESTURE NAMED AN AGENT, so it is consent for that agent and no
        // other. Connecting from the Connectors panel grants nobody, because
        // nothing there says who should have it; a thread pulled off this Boo
        // does say, and finishing it with a second trip to the grant composer
        // would ask a question the drag already answered.
        if (connected) {
          await grantConnectorToAgent(
            {
              targetAgentId: agentId,
              connectorId: connected.connectorId,
              capabilityId: null,
              // WRITE, NOT READ, and the difference is between working and not.
              // `requiredMode` (governance/grants/decide.ts:39) answers `read`
              // only for a tool whose server sent `readOnlyHint` AND whose
              // catalog entry is curated; everything else needs `write`. A read
              // grant would therefore be a grant that denies almost every call,
              // which looks exactly like the connector being broken. Still not
              // `admin`: a gesture with no dialog cannot consent to destructive
              // tools, and those keep asking.
              mode: 'write',
              approvalPolicy: 'risk',
            },
            { connectorName: def.displayName, targetAgentName: agentName },
          )
        }

        // BOTH refreshes. `triggerRefresh` rebuilds the graph; this one re-reads
        // live and configured state, which is what prices the picker. Without
        // it, reopening the picker offered the connector that was just turned
        // on, still labelled "Turn on".
        refreshConnectorCosts()
        useGraphStore.getState().triggerRefresh()
      }
    },
    [threadDrop, getNode, expandBoo, connectorCostOf, refreshConnectorCosts, refreshBrokeredApps],
  )

  /** Create an agent at the drop point, already routed from the source. */
  const handleThreadCreateAgent = useCallback(
    async (name: string) => {
      const drop = threadDrop
      setThreadDrop(null)
      if (!drop) return
      // THE TEAM COMES FROM THE THREAD, not from the view. A teamless agent is
      // not rendered on either canvas -- Atlas draws teams plus Boo Zero, and a
      // team view draws its own members -- so creating one teamless produced a
      // successful write and an invisible result, which is the worst outcome
      // this gesture can have. The thread was pulled off a Boo that belongs
      // somewhere, and inheriting that is also what the operator means.
      const sourceTeamId = (
        getNode(drop.fromNodeId)?.data as { teamId?: string | null } | undefined
      )?.teamId
      const teamId = sourceTeamId ?? fallbackTeamId
      const created = await spawnAgent(name, drop.flow, { teamId })
      if (!created) return
      // The routing line the thread implied. Best-effort: the agent exists
      // either way, and a failed route is recoverable by drawing it again.
      const sourceId = drop.fromNodeId.startsWith('boo-') ? drop.fromNodeId.slice(4) : null
      if (sourceId) {
        try {
          const md = await readAgentFile(sourceId, 'AGENTS.md').catch(() => '# AGENTS\n')
          const next = withRoutingAppended(md, created.name)
          if (next) {
            await mutationQueue.enqueue(sourceId, () => writeAgentFile(sourceId, 'AGENTS.md', next))
            useGraphStore.getState().setAgentFiles(sourceId, { agentsMd: next })
          }
        } catch {
          // The agent exists either way. A route that did not save is drawable
          // again by hand, so this must not read as a failed creation.
        }
      }
    },
    [threadDrop, fallbackTeamId, getNode],
  )

  /**
   * A thread let go on empty canvas: open the picker where it fell.
   *
   * RE-PRICE ON OPEN. The rows come from the live graph, but what each one
   * COSTS came from a snapshot taken when this canvas mounted, and nothing
   * revalidated it. Connect something in the Connectors tab, come back here,
   * and the picker still described the world as it was on mount: the connector
   * read as "Turn on" long after it was on. The read is cheap and its result
   * lands before anyone can pick a row.
   */
  const openFromDrop = useCallback(
    (event: MouseEvent | TouchEvent, fromNode: Pick<Node, 'id' | 'type'>) => {
      const point =
        'clientX' in event
          ? { x: event.clientX, y: event.clientY }
          : { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 }
      refreshConnectorCosts()
      setThreadDrop({
        screen: point,
        flow: screenToFlowPosition(point),
        fromNodeId: fromNode.id,
        fromNodeType: fromNode.type ?? null,
      })
    },
    [screenToFlowPosition, refreshConnectorCosts],
  )

  const close = useCallback(() => setThreadDrop(null), [])

  return {
    threadDrop,
    threadOptions,
    openFromDrop,
    close,
    pick: handleThreadPick,
    createAgent: handleThreadCreateAgent,
  }
}
