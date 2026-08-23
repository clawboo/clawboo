#!/usr/bin/env tsx
/**
 * Verify the committed connector catalog.
 *
 * Two modes, deliberately split the same way the marketplace ingest is:
 *
 *   pnpm verify:connectors          OFFLINE. No network. Gates PRs and the
 *                                   release path. Asserts the shipping
 *                                   invariants: version pins that actually
 *                                   appear in argv, https-only endpoints, no
 *                                   secret values, declared egress.
 *
 *   pnpm verify:connectors --live   Adds network. Re-resolves every pinned npm
 *                                   version and dials every remote endpoint.
 *                                   Runs weekly, never on the release path: an
 *                                   upstream yank or outage must not be able to
 *                                   hold up a release.
 *
 * The offline half deliberately overlaps the package's own vitest suite. That is
 * the point of a release gate: it must not depend on the test runner having been
 * run, and it must fail loudly on the publish path.
 *
 * Exits 0 when everything passes; 1 otherwise.
 */

import {
  CONNECTOR_DEFINITIONS,
  CURATED_CONNECTORS,
  COMMUNITY_CONNECTORS,
  connectorSnippet,
  SECRET_LOOKING_VALUE,
  SNIPPET_DIALECTS,
  type ConnectorDefinition,
} from '../packages/connector-catalog/src/index.js'

const LIVE = process.argv.includes('--live')

const failures: string[] = []

function fail(slug: string, message: string): void {
  failures.push(`  ❌ ${slug}: ${message}`)
}

// ─── Offline: the shipping invariants ────────────────────────────────────────

function checkOffline(): void {
  const seen = new Set<string>()

  for (const def of CONNECTOR_DEFINITIONS) {
    if (seen.has(def.slug)) fail(def.slug, 'duplicate slug')
    seen.add(def.slug)

    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(def.slug)) fail(def.slug, 'slug is not kebab-safe')

    if (def.launch.transport === 'stdio') {
      const { pinnedVersion, args, command } = def.launch
      if (!pinnedVersion) fail(def.slug, 'stdio launch has no pinnedVersion')
      // The pin must be in argv, not just recorded. A version in a field the
      // spawner never reads is theatre: `npx -y pkg` still resolves to @latest,
      // so the executing code changes with no consent event.
      else if (!args.some((a) => a.includes(`@${pinnedVersion}`)))
        fail(def.slug, `pinnedVersion ${pinnedVersion} does not appear in args`)
      if (!command) fail(def.slug, 'stdio launch has no command')
    } else if (!def.launch.url.startsWith('https://')) {
      fail(def.slug, 'remote endpoint is not https')
    }

    for (const input of def.auth.inputs) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(input.key))
        fail(def.slug, `input key ${input.key} is not an env-var name`)
      if (/TOKEN|KEY|SECRET|PASSWORD/.test(input.key) && !input.secret)
        fail(def.slug, `input ${input.key} looks secret but is not marked secret`)
    }
    if (def.auth.kind === 'api-key' && def.auth.inputs.length === 0)
      fail(def.slug, 'api-key auth declares no inputs')
    if (def.auth.kind === 'none' && def.auth.inputs.length > 0)
      fail(def.slug, 'auth kind "none" but inputs are declared')
    // A remote entry cannot carry env inputs: `connectorSnippet` emits
    // `{ type, url }` for JSON and a bare `url = …` for Codex, with no place to
    // reference a variable. Declaring one anyway would make `requiredEnv` tell
    // the user to set something the pasted block never reads. Every remote entry
    // is OAuth today; this is what keeps the next one from quietly shipping an
    // unauthenticatable snippet.
    if (def.launch.transport === 'streamable-http' && def.auth.inputs.length > 0)
      fail(
        def.slug,
        'remote (streamable-http) entries cannot declare auth inputs: the snippet has no header ' +
          'or env block to reference them. Teach connectorSnippet to emit headers first.',
      )

    if (def.trifecta.canEgress && def.egressAllow.length === 0)
      fail(def.slug, 'can egress but declares no allowed hosts')
    if (!def.trifecta.canEgress && def.egressAllow.length > 0)
      fail(def.slug, 'declares egress hosts but is marked unable to egress')

    // Every dialect must produce something pasteable, and never a literal secret.
    for (const { id } of SNIPPET_DIALECTS) {
      const snippet = connectorSnippet(def, id)
      if (snippet.body.trim() === '') fail(def.slug, `empty ${id} snippet`)
      if (SECRET_LOOKING_VALUE.test(snippet.body))
        fail(def.slug, `${id} snippet contains something that looks like a real credential`)
      if (snippet.language === 'json') {
        try {
          JSON.parse(snippet.body)
        } catch {
          fail(def.slug, `${id} snippet is not valid JSON`)
        }
      }
    }
  }

  const serialized = JSON.stringify(CONNECTOR_DEFINITIONS)
  if (/"icon(Url)?"\s*:\s*"https?:/i.test(serialized))
    failures.push('  ❌ catalog carries a remote icon URL. Inline it or drop it')
}

// ─── Live: does any of this still exist? ─────────────────────────────────────

async function checkNpm(def: ConnectorDefinition & { launch: { transport: 'stdio' } }) {
  const arg = def.launch.args.find((a) => a.includes(`@${def.launch.pinnedVersion}`))
  if (!arg) return
  const at = arg.lastIndexOf('@')
  const name = arg.slice(0, at)
  const version = arg.slice(at + 1)
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) fail(def.slug, `npm has no ${name}@${version} (yanked or renamed?)`)
  else if (!res.ok) fail(def.slug, `npm returned ${res.status} for ${name}@${version}`)
  else {
    // A deprecated version still resolves, so the 404 check above sails straight
    // past it. Curated means we vouch for it, and we cannot vouch for a package
    // whose own publisher says it is no longer supported.
    const meta = (await res.json()) as { deprecated?: string }
    if (typeof meta.deprecated === 'string')
      fail(def.slug, `npm marks ${name}@${version} deprecated: ${meta.deprecated}`)
    else console.log(`  ✓ ${def.slug} → ${name}@${version}`)
  }
}

async function checkEndpoint(
  def: ConnectorDefinition & { launch: { transport: 'streamable-http' } },
) {
  try {
    const res = await fetch(def.launch.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      signal: AbortSignal.timeout(10_000),
    })
    // 401 is the CORRECT answer from an OAuth-protected MCP server to an
    // unauthenticated initialize: it is what makes discovery possible. A 404 or
    // a connection failure is the real problem.
    if (res.status === 404) fail(def.slug, `endpoint ${def.launch.url} returned 404`)
    else console.log(`  ✓ ${def.slug} → ${def.launch.url} (HTTP ${res.status})`)
  } catch (err) {
    fail(def.slug, `endpoint ${def.launch.url} unreachable: ${(err as Error).message}`)
  }
}

async function checkLive(): Promise<void> {
  for (const def of CONNECTOR_DEFINITIONS) {
    if (def.launch.transport === 'stdio') {
      await checkNpm(def as ConnectorDefinition & { launch: { transport: 'stdio' } })
    } else {
      await checkEndpoint(def as ConnectorDefinition & { launch: { transport: 'streamable-http' } })
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `\n🔌 Clawboo connector catalog verify (${LIVE ? 'LIVE, network' : 'offline, no network'})`,
  )
  console.log(
    `   ${CURATED_CONNECTORS.length} curated · ${COMMUNITY_CONNECTORS.length} community\n`,
  )

  checkOffline()
  if (LIVE) await checkLive()

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} problem(s):\n`)
    console.error(failures.join('\n'))
    console.error(
      '\nThe catalog is hand-written under packages/connector-catalog/src/sources/.\n' +
        '  · A pinned version was yanked?  → bump it to a version that resolves, and re-verify.\n' +
        '  · An endpoint moved?            → update the entry, or drop it. A directory that lists\n' +
        '                                    a connector which does not install is worse than a\n' +
        '                                    shorter directory.\n',
    )
    process.exit(1)
  }

  console.log(`\n✅ All ${CONNECTOR_DEFINITIONS.length} connector entries pass\n`)
}

main().catch((err) => {
  console.error('\n❌ Verify failed:', (err as Error).message)
  process.exit(1)
})
