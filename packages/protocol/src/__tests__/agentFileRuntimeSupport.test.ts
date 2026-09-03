// Which agent files each runtime actually reads. This table is the single
// source of truth the editors gate their tabs on, so it is pinned here: a tab
// that appears for a runtime whose driver never reads the file is the exact
// false affordance the gating was added to remove.
//
// Ground truth, traced 2026-08-25: the seven names are OpenClaw's agent-file
// set. readNativeAgentFile / readRuntimeAgentFile each have exactly one
// production caller (their source's readFile), which itself has exactly one
// caller: the editor's REST GET. No driver prompt reads any of them.

import { describe, it, expect } from 'vitest'

import {
  AGENT_FILE_NAMES,
  AGENT_FILE_META,
  AGENT_FILE_RUNTIME_SUPPORT,
  agentFilesForRuntime,
} from '../index'

describe('agent file runtime support', () => {
  it('OpenClaw lists exactly the files clawboo seeds at agent creation', () => {
    // openClawAgentSource.createAgent writes these four and only these four.
    // Listing a file here makes its tab ALWAYS visible, so the list has to stop
    // at what clawboo itself puts there.
    expect(agentFilesForRuntime('openclaw')).toEqual([
      'SOUL.md',
      'IDENTITY.md',
      'TOOLS.md',
      'AGENTS.md',
    ])
    // Still the widest of the known runtimes.
    for (const rt of ['clawboo-native', 'claude-code', 'codex', 'hermes']) {
      expect(agentFilesForRuntime(rt).length).toBeLessThan(agentFilesForRuntime('openclaw').length)
    }
  })

  it('no runtime lists a file clawboo neither writes nor reads', () => {
    // USER / HEARTBEAT / MEMORY belong to OpenClaw's file set, but clawboo
    // never creates one and never reads one back. An always-on tab for them is
    // a control wired to nothing. They stay reachable through the editor's
    // "show any file that already has content" rule, so nothing is hidden.
    for (const name of ['USER.md', 'HEARTBEAT.md', 'MEMORY.md'] as const) {
      for (const rt of Object.keys(AGENT_FILE_RUNTIME_SUPPORT)) {
        expect(agentFilesForRuntime(rt)).not.toContain(name)
      }
    }
  })

  it('the coding runtimes get SOUL.md (injected as a persona block) plus AGENTS.md', () => {
    // Their drivers read no agent file from disk; clawboo injects SOUL.md into
    // the prompt itself (personaBlock.ts), which is also what makes the
    // Personality sliders effective here.
    for (const rt of ['claude-code', 'codex', 'hermes']) {
      expect(agentFilesForRuntime(rt)).toEqual(['SOUL.md', 'AGENTS.md'])
    }
  })

  it('SOUL.md is supported on every known runtime (Personality reaches them all)', () => {
    for (const rt of Object.keys(AGENT_FILE_RUNTIME_SUPPORT)) {
      expect(agentFilesForRuntime(rt)).toContain('SOUL.md')
    }
  })

  it('the unwired-but-seeded files stay OpenClaw-only', () => {
    for (const name of ['IDENTITY.md', 'TOOLS.md'] as const) {
      expect(agentFilesForRuntime('openclaw')).toContain(name)
      for (const rt of ['clawboo-native', 'claude-code', 'codex', 'hermes']) {
        expect(agentFilesForRuntime(rt)).not.toContain(name)
      }
    }
  })

  it('clawboo-native gets SOUL.md (it IS the systemPrompt) plus AGENTS.md', () => {
    expect(agentFilesForRuntime('clawboo-native')).toEqual(['SOUL.md', 'AGENTS.md'])
  })

  it('an unknown or missing runtime falls back to the full set', () => {
    // Never hide a file we cannot prove is inert.
    expect(agentFilesForRuntime(undefined)).toEqual(AGENT_FILE_NAMES)
    expect(agentFilesForRuntime(null)).toEqual(AGENT_FILE_NAMES)
    expect(agentFilesForRuntime('')).toEqual(AGENT_FILE_NAMES)
    expect(agentFilesForRuntime('some-future-runtime')).toEqual(AGENT_FILE_NAMES)
  })

  it('every supported name is a real agent file', () => {
    for (const names of Object.values(AGENT_FILE_RUNTIME_SUPPORT)) {
      for (const n of names) expect(AGENT_FILE_NAMES).toContain(n)
    }
  })

  it('no hint promises an effect the runtime does not deliver', () => {
    // The old copy asserted behavior for all seven on every runtime ("Durable
    // memory for this agent", "Small checklist for heartbeat runs"). Files that
    // only OpenClaw reads must not read as unconditional promises.
    // A hint that stops at what the file is reads as a promise. One of these
    // has to appear: who reads it, or what it does not do.
    const CAVEAT = /OpenClaw|Gateway|Does not|Never (writes|reads)|never reads|Not the/
    const notUniversal = AGENT_FILE_NAMES.filter((n) => !agentFilesForRuntime('codex').includes(n))
    expect(notUniversal.length).toBeGreaterThan(0)
    for (const name of notUniversal) {
      const hint = AGENT_FILE_META[name].hint
      expect(hint.length).toBeGreaterThan(0)
      expect(hint, `${name} hint must name a reader or a limit`).toMatch(CAVEAT)
    }
  })

  it('the MEMORY.md hint names the hermes collision', () => {
    // hermes keeps a REAL compounding MEMORY.md in its per-identity home that
    // clawboo never writes. Same filename, opposite guarantee.
    expect(AGENT_FILE_META['MEMORY.md'].hint).toMatch(/Hermes/i)
  })
})
