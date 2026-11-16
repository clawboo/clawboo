// The verified person check holds only if every decision about "is this the
// person?" goes through lib/auth.ts. One route that read the dashboard page's
// marks itself would keep treating the page as the person after an operator
// turned `personCheck: verified` on. These tripwires fail the moment that
// happens, and when a file starts deciding who the person is without a
// verified-mode test saying where it is covered.

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SERVER = path.resolve(__dirname, '../..')

/** Every server source file, as a path relative to server/, tests left out. */
function sources(dir = SERVER, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path.relative(SERVER, full).split(path.sep).join('/'))
    }
  }
  return out
}

const files = sources()
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8')
const using = (pattern: RegExp) => files.filter((f) => pattern.test(read(f))).sort()

describe('who reads the dashboard page’s marks', () => {
  it('only the person check itself calls isDashboardRequest', () => {
    expect(using(/\bisDashboardRequest\b/)).toEqual(['lib/auth.ts', 'lib/dashboardRequest.ts'])
  })

  it('no other server file reads fetch metadata', () => {
    // A header name in quotes, which reading one needs; a comment may name it.
    expect(using(/['"`]sec-fetch-(site|mode)['"`]/i)).toEqual(['lib/dashboardRequest.ts'])
  })
})

/**
 * Every file that decides who the person is, and the test that runs its routes
 * with `personCheck: verified`. A new file here needs a verified case first.
 */
const VERIFIED_COVERAGE: Record<string, string> = {
  'api/agentChat.ts': 'personCheckRoutes.test.ts (stopping a chat)',
  'api/agents.ts': 'personCheckRoutes.test.ts (REFUSED), computerPersonCheck.test.ts (screenshots)',
  'api/approvals.ts': 'personCheck.test.ts (approval history, from the verified page)',
  'api/board.ts': 'personCheck.test.ts and personCheckRoutes.test.ts',
  'api/boardPerson.ts': 'personCheckRoutes.test.ts (Reopen, assign, questions, wakes)',
  'api/booZeroOverride.ts': 'personCheckRoutes.test.ts',
  'api/budgets.ts': 'personCheckRoutes.test.ts',
  'api/capabilities.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/computer.ts': 'computerPersonCheck.test.ts',
  'api/execAllowlist.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/execSettings.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/grants.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/nativeShell.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/pauses.ts': 'personCheckRoutes.test.ts (pausing, resuming)',
  'api/rooms.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/runtimes.ts': 'lib/__tests__/auth.test.ts (actsAsPerson in both modes)',
  'api/schedules.ts': 'personCheckRoutes.test.ts (routines)',
  'api/system.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/teamAgentWakes.ts': 'personCheckRoutes.test.ts',
  'api/teamChat.ts': 'lib/__tests__/auth.test.ts (actsAsPerson in both modes)',
  'api/teamLabels.ts': 'personCheckRoutes.test.ts',
  'api/teamOnboarding.ts': 'personCheckRoutes.test.ts',
  'api/teamPlanApproval.ts': 'personCheckRoutes.test.ts',
  'api/teamRules.ts': 'personCheckRoutes.test.ts',
  'api/teamVerifyCommand.ts': 'personCheck.test.ts (a team’s work check, from the verified page)',
  'api/teams.ts': 'personCheckRoutes.test.ts (REFUSED)',
  'api/tools.ts': 'personCheck.test.ts (an approval answer, from the verified page)',
  'api/websiteLogins.ts': 'lib/__tests__/auth.test.ts (refuseUnlessPerson in both modes)',
  'lib/auth.ts': 'lib/__tests__/auth.test.ts',
  'lib/boardReader.ts': 'lib/__tests__/auth.test.ts (actsAsPerson in both modes)',
}

describe('who decides who the person is', () => {
  it('every such file has a verified-mode test named here', () => {
    expect(
      using(/\b(refuseUnlessPerson|refuseUnlessVerifiedPerson|actsAsPerson|actorField)\(/),
    ).toEqual(Object.keys(VERIFIED_COVERAGE).sort())
  })
})
