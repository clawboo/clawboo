import type { Node, Edge } from '@xyflow/react'
import type { AgentStatus } from '@clawboo/gateway-client'

// ─── Skill category ───────────────────────────────────────────────────────────

export type SkillCategory = 'data' | 'comm' | 'code' | 'file' | 'web' | 'other'

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

// ─── Typed ReactFlow nodes ────────────────────────────────────────────────────

export type BooNode = Node<BooNodeData, 'boo'>
export type SkillNode = Node<SkillNodeData, 'skill'>
export type ResourceNode = Node<ResourceNodeData, 'resource'>
export type GraphNode = BooNode | SkillNode | ResourceNode
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
