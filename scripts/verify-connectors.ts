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

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  CONNECTOR_DEFINITIONS,
  CURATED_CONNECTORS,
  connectRefusal,
  connectorCounts,
  connectorSnippet,
  isExactVersion,
  SECRET_LOOKING_VALUE,
  SNIPPET_DIALECTS,
  type ConnectorDefinition,
} from '../packages/connector-catalog/src/index.js'
import { COMMUNITY_SNAPSHOT_CAP, recordedDigest, snapshotDigest } from './lib/connector-snapshot.js'

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
    // A remote entry may carry inputs ONLY as a bearer, because that is the one
    // kind whose snippet has somewhere to put them. `connectorSnippet` emits an
    // Authorization header referencing the variable for `bearer`, and nothing
    // but `{ type, url }` for the rest, so declaring inputs on an OAuth remote
    // would make `requiredEnv` tell the user to set something the pasted block
    // never reads.
    if (
      def.launch.transport === 'streamable-http' &&
      def.auth.inputs.length > 0 &&
      def.auth.kind !== 'bearer'
    )
      fail(
        def.slug,
        'remote (streamable-http) entries may declare auth inputs only with auth.kind "bearer": ' +
          'no other kind emits a header to reference them.',
      )
    // ...and the converse, which is what makes the tile's price honest: a bearer
    // remote with no input is a connector nothing can ever authenticate.
    if (def.auth.kind === 'bearer' && def.auth.inputs.length === 0)
      fail(def.slug, 'bearer auth declares no inputs, so nothing can supply the token')

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

/**
 * The community band, checked as data rather than as a promise.
 *
 * These entries are NOT vouched for, which is the whole point of the band, so the
 * gate does not assert anything about the servers themselves. What it does assert
 * is that clawboo cannot accidentally start treating them as curated: the counts
 * must stay separable, nothing may claim curated provenance, every entry must be
 * pinned so a consent step can show real argv, and none may be connectable
 * directly.
 */
/**
 * The snapshot is what it says it is.
 *
 * THE ONE GATE THAT COVERS CONTENT. Everything else here checks SHAPE, and
 * shape is exactly what a hand-edit to an argv would preserve: swap
 * `some-mcp@1.0.0` for something else, keep every field, and the entry sails
 * through. This is a directory of unreviewed installers whose whole safety
 * story is "the consent step shows you the exact command", so the file backing
 * it has to be the file the ingest produced.
 *
 * Offline by construction, so it rides the ordinary CI run rather than the
 * weekly live one.
 */
async function checkSnapshotDigest(): Promise<void> {
  const file = path.join(process.cwd(), 'packages/connector-catalog/src/generated/community.ts')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    fail('community', 'the snapshot file could not be read')
    return
  }
  const claimed = recordedDigest(raw)
  if (!claimed) {
    fail('community', 'the snapshot carries no digest, so nothing pins its contents')
    return
  }
  const actual = await snapshotDigest(raw, file)
  if (actual !== claimed)
    fail(
      'community',
      `the snapshot does not match its digest (records ${claimed.slice(0, 12)}…, computes ` +
        `${actual.slice(0, 12)}…). It was edited by hand: re-run \`pnpm ingest:connectors\` ` +
        'and read the diff.',
    )
}

function checkCommunity(entries: readonly ConnectorDefinition[]): void {
  const CAP = COMMUNITY_SNAPSHOT_CAP
  if (entries.length > CAP) fail('community', `${entries.length} entries exceeds the ${CAP} cap`)
  // The count module rides the main entry so the header can state the snapshot's
  // size without its body. Generated together, but nothing else stops a hand
  // edit or a partial regeneration from letting them drift.
  if (connectorCounts().community !== entries.length)
    fail(
      'community',
      `COMMUNITY_COUNT says ${connectorCounts().community} but the snapshot holds ${entries.length}`,
    )
  const slugs = new Set<string>()
  const curated = new Set(CURATED_CONNECTORS.map((c) => c.slug))
  for (const def of entries) {
    if (def.provenance !== 'community')
      fail(def.slug, 'in the community snapshot but not marked community')
    if (curated.has(def.slug))
      fail(def.slug, 'shadows a curated slug, which would silently replace a vouched entry')
    if (slugs.has(def.slug)) fail(def.slug, 'duplicate slug in the community snapshot')
    slugs.add(def.slug)
    if (def.launch.transport !== 'stdio') {
      fail(
        def.slug,
        'remote community entries are not supported: no OAuth discovery has been run for them',
      )
      continue
    }
    // The consent step shows exact argv before anything runs, so an unpinned
    // entry would show the user one command and execute whatever @latest resolves
    // to on the day.
    if (!def.launch.pinnedVersion)
      fail(def.slug, 'no pinned version, so the consent step cannot show what will run')
    // EXACT, not merely present. `pkg@latest` satisfies both the presence check
    // and the argv check below while resolving to different code every day, so
    // without this the pinning contract is enforced only by spelling.
    else if (
      !isExactVersion(def.launch.pinnedVersion, def.launch.command === 'uvx' ? 'pypi' : 'npm')
    )
      fail(
        def.slug,
        `pinned version ${def.launch.pinnedVersion} is a tag or range, not one immutable release`,
      )
    if (!def.launch.args.some((a) => a.includes(def.launch.pinnedVersion)))
      fail(def.slug, `argv does not carry the pinned version ${def.launch.pinnedVersion}`)
    // Unread means unknown, and unknown has to be declared as the worst case
    // rather than as a narrow claim nobody checked.
    if (
      !def.trifecta.readsPrivateData ||
      !def.trifecta.ingestsUntrustedContent ||
      !def.trifecta.canEgress
    )
      fail(
        def.slug,
        'community entry declares a narrowed trifecta, which is a claim clawboo has not verified',
      )
    if (connectRefusal(def, true, true, true) !== 'community-unsandboxed')
      fail(def.slug, 'is directly connectable, bypassing the consent step')
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
  // The snapshot is loaded HERE rather than imported at the top, mirroring the
  // SPA: the curated directory must verify with no community bundle present, or
  // the gate would stop proving that the offline promise holds on its own.
  const { COMMUNITY_SNAPSHOT } = await import('../packages/connector-catalog/src/community.js')
  console.log(
    `   ${CURATED_CONNECTORS.length} curated · ${COMMUNITY_SNAPSHOT.length} community (unchecked)\n`,
  )

  checkOffline()
  checkCommunity(COMMUNITY_SNAPSHOT)
  await checkSnapshotDigest()
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

  console.log(
    `\n✅ ${CURATED_CONNECTORS.length} curated entries pass, ${COMMUNITY_SNAPSHOT.length} community entries are well-formed\n`,
  )
}

main().catch((err) => {
  console.error('\n❌ Verify failed:', (err as Error).message)
  process.exit(1)
})
