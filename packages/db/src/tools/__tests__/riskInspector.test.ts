// The read-only carve-out in `riskClassifierInspector`, and its blast radius.
//
// Why this file exists: `risk` is a CONNECTOR-level floor, so every tool on a
// browser connector is `external` — including the ones that only look at the
// page. Before the carve-out, a single page visit cost a modal click per call
// and "Allow always" did not help (it binds to the grant, which the inspector
// branch never reads). That is the shape of gate users learn to rubber-stamp.
//
// The blast radius is asserted here rather than reviewed by eye, because a
// catalog entry that gained `readOnlyHint` on a mutating tool would silently
// widen the carve-out.
//
// The carve-out is deliberately wide: a read-only call NEVER prompts, including
// on a connector holding the user's own records. Gating reads was measured
// against the alternative and rejected as too much friction for the thing every
// comparable tool lets through. Private data is not unguarded, it is guarded a
// layer up: `packages/governance/src/grants/decide.ts` prompts on every call,
// read or write, once a chain arms all three trifecta legs.

import { describe, expect, it } from 'vitest'

import { buildConnectorDescriptor } from '../connectorDescriptor'
import { riskClassifierInspector } from '../inspectors'
import type { ToolCall, ToolCallContext, ToolDescriptor } from '../types'

const call: ToolCall = { name: 't', args: {} }
const ctx = {} as ToolCallContext

async function decide(descriptor: Partial<ToolDescriptor>): Promise<string> {
  const full = { name: 't', description: '', inputSchema: {}, ...descriptor } as ToolDescriptor
  return (await riskClassifierInspector(call, full, ctx as never)).kind
}

async function kindOf(d: ToolDescriptor): Promise<string> {
  return (await riskClassifierInspector(call, d, ctx as never)).kind
}

/** The trifecta a browser connector declares in the shipped catalog. */
const BROWSER = { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true }
/** A connector that holds the user's own records, e.g. an issue tracker. */
const PRIVATE = { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true }

describe('riskClassifierInspector — the carve-out', () => {
  it('lets a vouched read through instead of prompting', async () => {
    expect(await decide({ risk: 'external', readOnly: true, trifecta: BROWSER })).toBe('allow')
  })

  it('still prompts for a mutating tool on the same connector', async () => {
    // browser_navigate and browser_click are NOT annotated readOnly, which is
    // the whole reason the carve-out is safe to make.
    expect(await decide({ risk: 'external', trifecta: BROWSER })).toBe('require_approval')
    expect(await decide({ risk: 'external', readOnly: false, trifecta: BROWSER })).toBe(
      'require_approval',
    )
  })

  it('lets a read through even on a connector holding PRIVATE records', async () => {
    // The deliberate wide edge of the rule. A read-only call does not prompt
    // wherever it points, because a gate that fires on every read is one people
    // learn to rubber-stamp. The exfiltration shape this leaves open is caught
    // by the lethal-trifecta gate in the grant layer, not here.
    expect(await decide({ risk: 'external', readOnly: true, trifecta: PRIVATE })).toBe('allow')
  })

  it('never lets a destructive tool through, whatever else it claims', async () => {
    expect(await decide({ risk: 'destructive' })).toBe('require_approval')
    expect(await decide({ risk: 'destructive', readOnly: true, trifecta: BROWSER })).toBe(
      'require_approval',
    )
    // A malformed manifest declaring BOTH still prompts: destructive outranks.
    expect(await decide({ risk: 'safe', destructive: true, readOnly: true })).toBe(
      'require_approval',
    )
  })

  it('leaves safe tools running unattended, as before', async () => {
    expect(await decide({ risk: 'safe' })).toBe('allow')
    expect(await decide({})).toBe('allow')
  })
})

describe('the carve-out cannot be reached by an untrusted server', () => {
  const facts = {
    name: 'browser_snapshot',
    description: 'Read the page',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }
  const opts = { name: 'mcp__x__browser_snapshot', trifecta: BROWSER, executor: () => '' }

  it('a CURATED connector earns the carve-out', async () => {
    const d = buildConnectorDescriptor(facts, { ...opts, trustAnnotations: true })
    expect(d.readOnly).toBe(true)
    expect(await kindOf(d)).toBe('allow')
  })

  it('a non-curated connector does NOT, even declaring readOnlyHint itself', async () => {
    // This is the load-bearing half. The annotation is the server's own word;
    // the trust has to come from the catalog vouching for the package.
    const d = buildConnectorDescriptor(facts, { ...opts, trustAnnotations: false })
    expect(d.readOnly).toBeUndefined()
    expect(await kindOf(d)).toBe('require_approval')
  })
})
