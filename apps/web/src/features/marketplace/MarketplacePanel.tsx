'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import type { InstalledSkillRecord } from '@/stores/marketplace'
import { mutationQueue } from '@/lib/mutationQueue'
import { useGraphStore } from '@/features/graph/store'
import { SKILL_CATALOG, searchCatalog } from './catalog'
import type { CatalogSkill } from './catalog'
import { AgentPickerDropdown } from './AgentPickerDropdown'
import type { SkillCategory } from '@/features/graph/types'

// ─── Category colours (matches SkillNode.tsx) ────────────────────────────────

const CATEGORY_META: Record<SkillCategory | 'all', { color: string; label: string }> = {
  all: { color: '#E8E8E8', label: 'All' },
  code: { color: '#F97316', label: 'Code' },
  file: { color: '#FBBF24', label: 'File' },
  web: { color: '#A855F7', label: 'Web' },
  comm: { color: '#34D399', label: 'Comm' },
  data: { color: '#3B82F6', label: 'Data' },
  other: { color: '#6B7280', label: 'Other' },
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  verified: { label: 'Verified', color: '#A855F7' },
  clawhub: { label: 'ClawHub', color: '#3B82F6' },
  'skill.sh': { label: 'skill.sh', color: '#34D399' },
  local: { label: 'Local', color: '#6B7280' },
}

function trustColor(score: number): string {
  if (score >= 80) return '#34D399'
  if (score >= 50) return '#FBBF24'
  return '#E94560'
}

// ─── Install skill from marketplace ──────────────────────────────────────────

async function installSkillFromMarketplace(
  skill: CatalogSkill,
  agentId: string,
  agentName: string,
) {
  const client = useConnectionStore.getState().client
  if (!client) return

  try {
    const currentTools = await client.agents.files.read(agentId, 'TOOLS.md')

    if (currentTools.toLowerCase().includes(skill.name.toLowerCase())) {
      useToastStore.getState().addToast({
        message: `${skill.name} already installed on ${agentName}`,
        type: 'info',
      })
      return
    }

    const newTools = currentTools.trimEnd() + '\n- ' + skill.name + '\n'
    await mutationQueue.enqueue(agentId, () =>
      client.agents.files.set(agentId, 'TOOLS.md', newTools),
    )

    // Persist to SQLite (best-effort)
    try {
      await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: skill.id,
          name: skill.name,
          source: skill.source,
          category: skill.category,
          trustScore: skill.trustScore,
          agentId,
          version: skill.version,
          author: skill.author,
        }),
      })
    } catch {
      // Non-fatal — TOOLS.md is the real source of truth
    }

    // Update marketplace store
    const record: InstalledSkillRecord = {
      skillId: skill.id,
      name: skill.name,
      source: skill.source,
      category: skill.category,
      trustScore: skill.trustScore,
      installedAt: Date.now(),
      agentIds: [agentId],
    }
    useMarketplaceStore.getState().markInstalled(skill.id, agentId, record)

    useGraphStore.getState().triggerRefresh()

    useToastStore.getState().addToast({
      message: `Installed "${skill.name}" on ${agentName}`,
      type: 'success',
    })
  } catch (err) {
    useToastStore.getState().addToast({
      message: `Failed to install: ${err instanceof Error ? err.message : 'unknown'}`,
      type: 'error',
    })
  }
}

// ─── SkillCard ───────────────────────────────────────────────────────────────

function SkillCard({ skill, index }: { skill: CatalogSkill; index: number }) {
  const [showPicker, setShowPicker] = useState(false)
  const cat = CATEGORY_META[skill.category] ?? CATEGORY_META.other
  const src = SOURCE_LABELS[skill.source] ?? SOURCE_LABELS.local

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.5) }}
      style={{
        position: 'relative',
        background: '#111827',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: 10,
        padding: '14px 16px',
        transition: 'border-color 0.15s',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)'
      }}
    >
      {/* Top row: dot + name + source badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: cat.color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: '#E8E8E8', flex: 1, minWidth: 0 }}>
          {skill.name}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: src.color,
            background: `${src.color}18`,
            border: `1px solid ${src.color}35`,
            borderRadius: 4,
            padding: '1px 6px',
            whiteSpace: 'nowrap',
            letterSpacing: '0.03em',
          }}
        >
          {src.label}
        </span>
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 12,
          color: 'rgba(232,232,232,0.55)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {skill.description}
      </div>

      {/* Trust bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.06)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${skill.trustScore}%`,
              height: '100%',
              borderRadius: 2,
              background: trustColor(skill.trustScore),
              transition: 'width 0.3s',
            }}
          />
        </div>
        <span style={{ fontSize: 10, color: 'rgba(232,232,232,0.35)', whiteSpace: 'nowrap' }}>
          {skill.trustScore}%
        </span>
      </div>

      {/* Bottom row: author + version + install */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 10,
            color: 'rgba(232,232,232,0.35)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {skill.author}
          {skill.version && (
            <span style={{ marginLeft: 6, color: 'rgba(232,232,232,0.25)' }}>v{skill.version}</span>
          )}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            setShowPicker((v) => !v)
          }}
          style={{
            background: 'rgba(52,211,153,0.15)',
            border: '1px solid rgba(52,211,153,0.35)',
            color: '#34D399',
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 6,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(52,211,153,0.25)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(52,211,153,0.15)'
          }}
        >
          Install
        </button>
      </div>

      {/* Agent picker */}
      {showPicker && (
        <AgentPickerDropdown
          onSelect={(agentId, agentName) => {
            void installSkillFromMarketplace(skill, agentId, agentName)
          }}
          onClose={() => setShowPicker(false)}
          style={{ top: '100%', right: 0, marginTop: 4 }}
        />
      )}
    </motion.div>
  )
}

// ─── MarketplacePanel ────────────────────────────────────────────────────────

export function MarketplacePanel() {
  const searchQuery = useMarketplaceStore((s) => s.searchQuery)
  const setSearchQuery = useMarketplaceStore((s) => s.setSearchQuery)
  const categoryFilter = useMarketplaceStore((s) => s.categoryFilter)
  const setCategoryFilter = useMarketplaceStore((s) => s.setCategoryFilter)
  const sortBy = useMarketplaceStore((s) => s.sortBy)
  const setSortBy = useMarketplaceStore((s) => s.setSortBy)

  const filteredSkills = useMemo(() => {
    let results: CatalogSkill[] = searchQuery ? searchCatalog(searchQuery) : [...SKILL_CATALOG]

    if (categoryFilter !== 'all') {
      results = results.filter((s) => s.category === categoryFilter)
    }

    switch (sortBy) {
      case 'trust':
        results.sort((a, b) => b.trustScore - a.trustScore)
        break
      case 'category':
        results.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
        break
      case 'name':
      default:
        results.sort((a, b) => a.name.localeCompare(b.name))
        break
    }

    return results
  }, [searchQuery, categoryFilter, sortBy])

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0A0E1A' }}
    >
      {/* Toolbar */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#E8E8E8' }}>Skill Marketplace</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: '#A855F7',
              background: 'rgba(168,85,247,0.1)',
              borderRadius: 20,
              padding: '1px 8px',
            }}
          >
            {filteredSkills.length} skill{filteredSkills.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'name' | 'trust' | 'category')}
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6,
            color: 'rgba(232,232,232,0.6)',
            fontSize: 11,
            padding: '3px 8px',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="name">Name A–Z</option>
          <option value="trust">Trust Score</option>
          <option value="category">Category</option>
        </select>
      </div>

      {/* Filter bar */}
      <div
        style={{
          flexShrink: 0,
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
        }}
      >
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <Search
            size={14}
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'rgba(232,232,232,0.3)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            placeholder="Search skills…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 10px 6px 32px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 6,
              color: '#E8E8E8',
              fontSize: 12,
              outline: 'none',
            }}
          />
        </div>

        {/* Category pills */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(Object.keys(CATEGORY_META) as (SkillCategory | 'all')[]).map((key) => {
            const isActive = categoryFilter === key
            const { color, label } = CATEGORY_META[key]
            return (
              <button
                key={key}
                onClick={() => setCategoryFilter(key)}
                style={{
                  background: isActive ? `${color}20` : 'transparent',
                  border: isActive ? `1px solid ${color}55` : '1px solid rgba(255,255,255,0.06)',
                  color: isActive ? color : 'rgba(232,232,232,0.45)',
                  borderRadius: 12,
                  padding: '3px 10px',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Grid */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
        }}
      >
        {filteredSkills.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: 60,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 28 }}>🔍</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(232,232,232,0.38)' }}>
              No skills match your search
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'rgba(232,232,232,0.25)',
                textAlign: 'center',
                maxWidth: 280,
                lineHeight: 1.6,
              }}
            >
              Try a different keyword or clear the category filter.
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 10,
            }}
          >
            {filteredSkills.map((skill, i) => (
              <SkillCard key={skill.id} skill={skill} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
