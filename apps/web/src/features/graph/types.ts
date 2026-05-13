import type { Node, Edge } from '@xyflow/react'
import type { AgentStatus } from '@clawboo/gateway-client'

// ─── Skill category ───────────────────────────────────────────────────────────

export type SkillCategory = 'data' | 'comm' | 'code' | 'file' | 'web' | 'other'

// ─── Ghost Graph scope ────────────────────────────────────────────────────────
//
// `'atlas'`: global all-teams view (rendered in the nav slot via
// `ContentArea`). Ignores `selectedTeamId`, synthesizes Boo Zero at the top
// with edges fanning out to every team's internal lead. Halos toggle is
// visible.
//
// `'team'`: single-team view bound to `selectedTeamId` (rendered inside
// `GroupChatView`). Halos toggle hidden + halos forced off regardless of
// the sticky `showTeamHalos` value.
export type GhostGraphScope = 'atlas' | 'team'

// ─── Node data shapes ─────────────────────────────────────────────────────────
// Each must extend Record<string, unknown> for @xyflow/react's generic constraint.

export interface BooNodeData extends Record<string, unknown> {
  agentId: string
  name: string
  status: AgentStatus
  model: string | null
  isStreaming: boolean
  edgeCount?: number
  teamId: string | null
  teamName?: string
  teamColor?: string
  teamEmoji?: string
  /**
   * When `true`, this Boo is Clawboo's universal team leader (Boo Zero).
   * Rendering adds a crown badge + "Universal Leader" label, and the node
   * is excluded from `TeamHaloLayer` grouping (it sits above teams, not
   * inside them).
   */
  isUniversalLeader?: boolean
}

export interface SkillNodeData extends Record<string, unknown> {
  skillId: string
  name: string
  category: SkillCategory
  description: string | null
  agentIds: string[]
  /**
   * Set by `GhostGraph`'s visibleNodes memo from `expandedBooNodeIds`.
   * Drives the peacock-feather expand / collapse animation inside the
   * node component. Optional + defaulted by the consumer:
   *   - undefined → treat as "always visible" (used by MiniGraph, which
   *     doesn't toggle visibility)
   *   - true → expanded (full opacity, full scale)
   *   - false → collapsed (opacity 0, scale 0, behind the parent Boo)
   */
  isVisible?: boolean
  /**
   * When `true`, this is the synthesized "Leadership" orbital that
   * accompanies Boo Zero. Replaces the old crown badge as Boo Zero's
   * visible leadership signal. `SkillNode` overrides its color + icon
   * and hides the Install button when this is set (the skill is bound
   * to Boo Zero — non-transferrable). Synthesized in `useGraphData.ts`
   * for every Boo with `BooNodeData.isUniversalLeader === true`. Not
   * present in TOOLS.md.
   */
  isLeadership?: boolean
}

export interface ResourceNodeData extends Record<string, unknown> {
  resourceId: string
  name: string
  serviceIcon: string
  agentIds: string[]
  /**
   * Same semantics as `SkillNodeData.isVisible`. See note above.
   */
  isVisible?: boolean
}

// ─── Team-root node ──────────────────────────────────────────────────────────
//
// Invisible routing-only node synthesized in the Atlas view to act as the
// JUNCTION between Boo Zero and a team's members. Reflects the user-drawn
// sketch: BZ at top → vertical line → horizontal trunk → per-team
// vertical → team's own trunk → members. The team-root sits at the
// vertical-trunk position above each team's cluster. It's invisible in
// the canvas (`TeamRootNode` renders only handle anchors, not a Boo) but
// real to ELK and to the spanning tree, so the edges route through it
// naturally.
//
// Why this and not the previous "anchor = first team member" idea: an
// anchor that IS a team member adds a visible extra hierarchy level (one
// member sits above its siblings). A team-root is invisible, so visually
// every team member is still on the same level under Boo Zero — exactly
// what the user wanted from the team-scoped Ghost Graph.
export interface TeamRootNodeData extends Record<string, unknown> {
  teamId: string
}

// ─── Typed ReactFlow nodes ────────────────────────────────────────────────────

export type BooNode = Node<BooNodeData, 'boo'>
export type SkillNode = Node<SkillNodeData, 'skill'>
export type ResourceNode = Node<ResourceNodeData, 'resource'>
export type TeamRootNode = Node<TeamRootNodeData, 'team-root'>
export type GraphNode = BooNode | SkillNode | ResourceNode | TeamRootNode
export type GraphEdge = Edge<Record<string, unknown>>

// ─── Parser output types ──────────────────────────────────────────────────────

export interface ParsedSkill {
  id: string
  name: string
  category: SkillCategory
  description: string | null
}

export interface ParsedResource {
  id: string
  name: string
  serviceIcon: string
}

export interface ParsedBinding {
  targetAgentName: string
}

// ─── Layout persistence ───────────────────────────────────────────────────────

export interface LayoutData {
  positions: Record<string, { x: number; y: number }>
}
