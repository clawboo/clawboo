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

import { refreshFleetFromRegistry } from '@/lib/agentSourceClient'
import { defaultAgentSource } from '@/lib/defaultAgentSource'
import { updateRoom } from '@/lib/roomsClient'
import { useRoomStore } from '@/stores/rooms'
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
 * canvas-legal action rather than a form. The runtime is not asked either: the
 * agent goes where Create Boo's would (see defaultAgentSource).
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
    const sourceId = await defaultAgentSource()
    res = await apiFetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: trimmed,
        sourceId,
        ...(opts.teamId ? { teamId: opts.teamId } : {}),
      }),
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
    await redrawWithNewAgent()
    return null
  }

  // BEFORE the refresh, not after. See the file header.
  placeSpawnedNode(`boo-${agentId}`, at)
  await redrawWithNewAgent()
  return { agentId, name: trimmed }
}

/**
 * Rebuild the canvas with the new agent in it. The canvas draws the fleet
 * store. With a Gateway, its presence events re-read the registry into that
 * store; with no Gateway nothing does, so without this read a new Clawboo
 * Native agent exists and is drawn only after a reload.
 */
async function redrawWithNewAgent(): Promise<void> {
  await refreshFleetFromRegistry().catch(() => undefined)
  useGraphStore.getState().triggerRefresh()
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

/** The last join sent to each room. A join waits for the one before it, so the
 *  server applies them in order and each response is newer than the last. */
const roomJoins = new Map<string, Promise<void>>()

/**
 * Add a just-created agent to a chat room's members.
 *
 * A room's graph draws only the room's members, so an agent created on it
 * joins the room as well as the team. The server does the add
 * (`addMemberIds`), so two agents joining at once both stay, and it refuses a
 * room or an agent outside `teamId`. Joins to one room go one at a time: if
 * two ran together, the older response could land last and replace the newer
 * room in the store, hiding the second agent.
 */
export function joinRoom(teamId: string, roomId: string, agent: SpawnAgentResult): Promise<void> {
  // A join that failed must not stop the ones queued behind it.
  const previous = (roomJoins.get(roomId) ?? Promise.resolve()).catch(() => undefined)
  const next = previous.then(() => addToRoom(teamId, roomId, agent))
  roomJoins.set(roomId, next)
  const forget = (): void => {
    if (roomJoins.get(roomId) === next) roomJoins.delete(roomId)
  }
  next.then(forget, forget)
  return next
}

async function addToRoom(teamId: string, roomId: string, agent: SpawnAgentResult): Promise<void> {
  const result = await updateRoom(teamId, roomId, { addMemberIds: [agent.agentId] })
  if (result.ok) {
    useRoomStore.getState().upsert(result.room)
    return
  }
  const roomName = useRoomStore
    .getState()
    .roomsByTeam.get(teamId)
    ?.find((r) => r.id === roomId)?.name
  useToastStore.getState().addToast({
    type: 'error',
    message: `${agent.name} was created but could not join ${roomName ?? 'the room'}: ${result.error}`,
  })
}
