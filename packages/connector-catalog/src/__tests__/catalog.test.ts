import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  CONNECTOR_DEFINITIONS,
  CURATED_CONNECTORS,
  connectorBySlug,
  connectorCounts,
  connectorsByCategory,
  connectorSnippet,
  searchConnectors,
  SNIPPET_DIALECTS,
} from '../index'

// zod is a devDependency ONLY. The catalog ships as plain data, so the shape
// guarantee is paid for once at build time rather than on every page load.
const inputSchema = z.object({
  key: z.string().min(1),
  description: z.string().min(1),
  docsUrl: z.string().url().optional(),
  required: z.boolean(),
  secret: z.boolean(),
})

const launchSchema = z.union([
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    pinnedVersion: z.string().min(1),
  }),
  z.object({ transport: z.literal('streamable-http'), url: z.string().url() }),
])

const definitionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  displayName: z.string().min(1),
  description: z.string().min(1),
  category: z.enum([
    'dev',
    'issues',
    'chat',
    'docs',
    'data',
    'observability',
    'browser',
    'search',
    'productivity',
    'finance',
  ]),
  provenance: z.enum(['curated', 'community']),
  launch: launchSchema,
  auth: z.object({
    kind: z.enum(['none', 'api-key', 'bearer', 'oauth']),
    inputs: z.array(inputSchema),
    scopes: z.array(z.string()).optional(),
    scopesRationale: z.string().optional(),
    setupGuide: z
      .object({
        console: z.string().min(1),
        url: z.string().url(),
        steps: z.array(z.string().min(1)).min(1),
      })
      .optional(),
  }),
  egressAllow: z.array(z.string()),
  trifecta: z.object({
    readsPrivateData: z.boolean(),
    ingestsUntrustedContent: z.boolean(),
    canEgress: z.boolean(),
  }),
  tags: z.array(z.string().min(1)),
  homepage: z.string().url().optional(),
  catalogId: z.string().optional(),
  deprecatedMessage: z.string().optional(),
})

describe('catalog shape', () => {
  it('validates every entry', () => {
    for (const entry of CONNECTOR_DEFINITIONS) {
      const result = definitionSchema.safeParse(entry)
      if (!result.success) {
        throw new Error(`${entry.slug}: ${result.error.message}`)
      }
    }
  })

  it('has unique slugs', () => {
    const slugs = CONNECTOR_DEFINITIONS.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('is not empty', () => {
    expect(CURATED_CONNECTORS.length).toBeGreaterThan(0)
  })
})

describe('the honesty invariants', () => {
  it('carries no remote icon URLs', () => {
    // A remote icon is a per-render call home from a local-first app, and a
    // tracking vector on a page that lists what you have connected. Icons must be
    // inlined at ingest or omitted.
    const serialized = JSON.stringify(CONNECTOR_DEFINITIONS)
    expect(serialized).not.toMatch(/"icon(Url)?"\s*:\s*"https?:/i)
  })

  it('pins a concrete version on every stdio launch', () => {
    // A bare `npx -y <pkg>` resolves to @latest on every spawn, so the executing
    // code changes with no consent event. The pin must also actually appear in
    // argv: recording it in a field the spawner never reads would be theatre.
    for (const c of CONNECTOR_DEFINITIONS) {
      // Bound to a local so the discriminated-union narrowing survives into the
      // `.some()` callback, where TS would otherwise widen it back.
      const launch = c.launch
      if (launch.transport !== 'stdio') continue
      expect(launch.pinnedVersion, c.slug).toMatch(/\d/)
      expect(
        launch.args.some((a) => a.includes(`@${launch.pinnedVersion}`)),
        c.slug,
      ).toBe(true)
    }
  })

  it('uses https for every remote endpoint', () => {
    for (const c of CONNECTOR_DEFINITIONS) {
      if (c.launch.transport !== 'streamable-http') continue
      expect(c.launch.url.startsWith('https://'), c.slug).toBe(true)
    }
  })

  it('never records a secret VALUE, only a key name', () => {
    for (const c of CONNECTOR_DEFINITIONS) {
      for (const input of c.auth.inputs) {
        expect(input.key, c.slug).toMatch(/^[A-Z][A-Z0-9_]*$/)
        expect(Object.keys(input), c.slug).not.toContain('value')
      }
    }
  })

  it('marks every secret input as secret', () => {
    for (const c of CONNECTOR_DEFINITIONS) {
      for (const input of c.auth.inputs) {
        if (/TOKEN|KEY|SECRET|PASSWORD/.test(input.key)) {
          expect(input.secret, `${c.slug}:${input.key}`).toBe(true)
        }
      }
    }
  })

  it('requires at least one input for api-key auth, and none for oauth or none', () => {
    for (const c of CONNECTOR_DEFINITIONS) {
      if (c.auth.kind === 'api-key') expect(c.auth.inputs.length, c.slug).toBeGreaterThan(0)
      if (c.auth.kind === 'none') expect(c.auth.inputs, c.slug).toHaveLength(0)
    }
  })

  it('declares inputs on a REMOTE entry only when the snippet can carry them', () => {
    // The original invariant was "a remote entry never declares inputs", and its
    // reason was that `connectorSnippet` emitted `{ type, url }` for JSON and a
    // bare `url = …` for Codex, neither of which could reference a variable. A
    // remote entry with inputs would then print "you will also need X" beside a
    // block that reads nothing.
    //
    // A bearer entry now emits an Authorization header referencing the variable,
    // so the reason no longer holds for that one kind. It still holds for every
    // other kind, and that is what this asserts. Mirrored in
    // scripts/verify-connectors.ts, which is the release gate.
    for (const c of CONNECTOR_DEFINITIONS) {
      if (c.launch.transport !== 'streamable-http') continue
      if (c.auth.kind === 'bearer') {
        expect(c.auth.inputs.length, c.slug).toBeGreaterThan(0)
        continue
      }
      expect(c.auth.inputs, c.slug).toHaveLength(0)
    }
  })

  it('a remote bearer entry emits a header that REFERENCES its token, never contains one', () => {
    // The block is copied into a file on the operator's disk. Rendering the
    // token itself would be writing their credential to plaintext on their
    // behalf, from a package whose whole posture is that values never leave the
    // vault.
    const github = connectorBySlug('github')!
    for (const dialect of SNIPPET_DIALECTS) {
      const body = connectorSnippet(github, dialect.id).body
      expect(body, dialect.id).toContain('GITHUB_TOKEN')
      expect(body, dialect.id).toMatch(/Authorization/i)
    }
  })

  it('passes an allowed directory to the filesystem server', () => {
    // Started with neither a directory argument nor a non-empty Roots set from
    // the client, this server throws during initialization. Every dialect renders
    // `args` verbatim, so carrying the placeholder here is what makes all three
    // snippets startable.
    const fs = connectorBySlug('filesystem')
    expect(fs).toBeDefined()
    const launch = fs!.launch
    expect(launch.transport).toBe('stdio')
    if (launch.transport !== 'stdio') return
    const trailing = launch.args[launch.args.length - 1]
    expect(trailing.startsWith('/'), 'last arg should be a directory path').toBe(true)
    expect(trailing).not.toContain('@')
  })

  it('declares egress on anything that can reach the network', () => {
    for (const c of CONNECTOR_DEFINITIONS) {
      if (!c.trifecta.canEgress) continue
      expect(c.egressAllow.length, c.slug).toBeGreaterThan(0)
    }
  })

  it('marks a local-only connector as unable to egress', () => {
    for (const c of CONNECTOR_DEFINITIONS) {
      if (c.egressAllow.length === 0) expect(c.trifecta.canEgress, c.slug).toBe(false)
    }
  })
})

describe('lookups', () => {
  it('finds by slug and returns undefined for an unknown one', () => {
    expect(connectorBySlug('filesystem')?.displayName).toBe('Filesystem')
    expect(connectorBySlug('nope')).toBeUndefined()
  })

  it('filters by category', () => {
    const browser = connectorsByCategory('browser')
    expect(browser.length).toBeGreaterThan(0)
    expect(browser.every((c) => c.category === 'browser')).toBe(true)
  })

  it('reports counts as a curated/community split, never one total', () => {
    const counts = connectorCounts()
    expect(counts.curated).toBe(CURATED_CONNECTORS.length)
    expect(counts).toHaveProperty('community')
  })
})

describe('searchConnectors', () => {
  it('returns everything for an empty query', () => {
    expect(searchConnectors('  ')).toHaveLength(CONNECTOR_DEFINITIONS.length)
  })

  it('matches on a one- or two-character query: there is no silent minimum', () => {
    // A silent below-N no-op reads as a broken box, so there is no minimum.
    expect(searchConnectors('gi').length).toBeGreaterThan(0)
  })

  it('matches name, slug, description and tags', () => {
    expect(searchConnectors('Playwright').map((c) => c.slug)).toContain('playwright')
    expect(searchConnectors('sqlite').map((c) => c.slug)).toContain('sqlite')
    expect(searchConnectors('issues').length).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    expect(searchConnectors('NOTION')).toEqual(searchConnectors('notion'))
  })

  it('returns an empty list rather than throwing on no match', () => {
    expect(searchConnectors('zzzzzz')).toEqual([])
  })
})
