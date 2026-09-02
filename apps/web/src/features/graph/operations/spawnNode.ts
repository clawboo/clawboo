// Spawning: create a thing, and keep it where it was dropped.
//
// THE POSITION IS WRITTEN BEFORE THE NODE ARRIVES, and that ordering is the
// whole operation. `useGraphData` replaces the entire node array from
// server-derived truth on every rebuild, so a spawned node cannot be staged
// client-side; it appears only after the refetch. In the window between the
// POST returning and that rebuild landing, nothing on the canvas knows the node
// exists -- and the layout effect treats a Boo with no saved position as
// evidence that the whole saved blob is stale, throws all of it away, and
// re-solves from scratch. Every node on the canvas jumps.
//
// Writing `boo-<newId>` into savedPositions the moment the id is known closes
// that window: by the time the rebuild runs, coverage is complete, the layout
// effect leaves the saved positions alone, and the new node is already sitting
// exactly where the thread was released.

import { apiFetch } from '@clawboo/control-client'

import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '../store'

/** Where the drop happened, in FLOW coordinates (not screen pixels). */
export interface SpawnAt {
  x: number
  y: number
}

/**
 * Record a deliberate placement for a node id that does not exist yet.
 *
 * Safe to call before the node is in the graph: `savedPositions` is a plain
 * id→point map that the layout effect reads by id, and an entry for an id the
 * current array does not contain is simply not consulted. The pruning pass in
 * the layout effect only drops ids that are absent from a COMPLETED rebuild, so
 * an entry written a few hundred milliseconds early survives.
 */
export function placeSpawnedNode(nodeId: string, at: SpawnAt): void {
  useGraphStore.getState().updateNodePosition(nodeId, { x: at.x, y: at.y })
}

export interface SpawnAgentResult {
  agentId: string
  name: string
}

/**
 * Create an agent and place it where the thread was released.
 *
 * `name` is the ONLY field the server requires (POST /api/agents 400s on a
 * missing or blank name and on nothing else), which is what makes this a
 * canvas-legal action rather than a form.
 */
export async function spawnAgent(
  name: string,
  at: SpawnAt,
  opts: { teamId?: string | null } = {},
): Promise<SpawnAgentResult | null> {
  const trimmed = name.trim()
  if (!trimmed) return null

  let res: Response
  try {
    res = await apiFetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed, ...(opts.teamId ? { teamId: opts.teamId } : {}) }),
    })
  } catch {
    useToastStore
      .getState()
      .addToast({ message: 'Could not reach the server. Nothing was created.', type: 'error' })
    return null
  }

  if (!res.ok) {
    let message = `Could not create ${trimmed}.`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* keep the generic message */
    }
    useToastStore.getState().addToast({ message, type: 'error' })
    return null
  }

  const body = (await res.json().catch(() => null)) as { agent?: { id?: string } } | null
  const agentId = body?.agent?.id
  if (!agentId) {
    // The write succeeded but we cannot key a position without the id. Refresh
    // so the node still appears; it will be laid out rather than placed.
    useGraphStore.getState().triggerRefresh()
    return null
  }

  // BEFORE the refresh, not after. See the file header.
  placeSpawnedNode(`boo-${agentId}`, at)
  useGraphStore.getState().triggerRefresh()
  return { agentId, name: trimmed }
}

/**
 * Put an agent into a team.
 *
 * One round-trip, no user input, and an upsert -- so dropping a Boo that is
 * already in the team is a no-op rather than an error.
 */
export async function joinTeam(
  teamId: string,
  agentId: string,
  agentName: string,
  teamName: string,
): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId }),
    })
    if (!res.ok) {
      useToastStore
        .getState()
        .addToast({ message: `Could not add ${agentName} to ${teamName}.`, type: 'error' })
      return false
    }
  } catch {
    useToastStore.getState().addToast({ message: 'Could not reach the server.', type: 'error' })
    return false
  }
  useGraphStore.getState().triggerRefresh()
  return true
}
