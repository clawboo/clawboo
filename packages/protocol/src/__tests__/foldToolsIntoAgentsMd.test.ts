// TOOLS.md notes move into AGENTS.md for OpenClaw agents. The 2026.9 Gateway
// stopped loading TOOLS.md and refuses to write it, so this is how a
// Marketplace member's skill list still reaches the model.

import { describe, expect, it } from 'vitest'

import { foldToolsIntoAgentsMd } from '../index'

const TOOLS = '# TOOLS\n\n## Skills\n- web-search\n- email-draft\n'

describe('foldToolsIntoAgentsMd', () => {
  it('appends the notes under a "## Tools" section, keeping their headings below it', () => {
    const out = foldToolsIntoAgentsMd('# AGENTS\n\nRoute to @Scout.\n', TOOLS)
    expect(out).toBe(
      '# AGENTS\n\nRoute to @Scout.\n\n## Tools\n\n### Skills\n- web-search\n- email-draft\n',
    )
  })

  it('adds nothing for an empty or heading-only TOOLS.md', () => {
    expect(foldToolsIntoAgentsMd('# AGENTS\n', '# TOOLS\n')).toBe('# AGENTS\n')
    expect(foldToolsIntoAgentsMd('# AGENTS\n', '')).toBe('# AGENTS\n')
    expect(foldToolsIntoAgentsMd('# AGENTS\n', undefined)).toBe('# AGENTS\n')
  })

  it('does not add the same notes twice', () => {
    const once = foldToolsIntoAgentsMd('# AGENTS\n', TOOLS)
    expect(foldToolsIntoAgentsMd(once, TOOLS)).toBe(once)
  })

  it('leaves lines inside fenced code alone', () => {
    const tools = [
      '# TOOLS',
      '',
      '## Deploy',
      '```bash',
      '# build first',
      'make build',
      '```',
      '~~~',
      '## not a heading either',
      '~~~',
      '### After',
    ].join('\n')
    expect(foldToolsIntoAgentsMd('# AGENTS\n', tools)).toBe(
      [
        '# AGENTS',
        '',
        '## Tools',
        '',
        '### Deploy',
        '```bash',
        '# build first',
        'make build',
        '```',
        '~~~',
        '## not a heading either',
        '~~~',
        '#### After',
        '',
      ].join('\n'),
    )
  })

  it('works when there is no AGENTS.md yet', () => {
    expect(foldToolsIntoAgentsMd(undefined, '# TOOLS\n\nUse the staging SSH alias.\n')).toBe(
      '## Tools\n\nUse the staging SSH alias.\n',
    )
  })
})
