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
}

export interface SkillNodeData extends Record<string, unknown> {
  skillId: string
  name: string
  category: SkillCategory
  description: string | null
  agentIds: string[]
}

export interface ResourceNodeData extends Record<string, unknown> {
  resourceId: string
  name: string
  serviceIcon: string
  agentIds: string[]
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
