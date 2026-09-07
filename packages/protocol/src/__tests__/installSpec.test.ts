// The npm spec clawboo installs the Gateway with.
//
// This file exists because of one character. The install line read
// `openclaw@^2026.5` under a comment that said it pinned new users to the 2026.5
// line. Caret pins only the leftmost non-zero digit, so it meant "any 2026.x",
// and npm was serving 2026.9.1 to every fresh install. Four things break on that
// version: agent creation, the capability toggles, chat sends and approvals.
//
// Nothing caught it because nothing looked. The spec was a string literal in a
// spawn call, duplicated in two more places that had drifted to `@latest`, and no
// test asserted what range it described. These assertions are cheap and they fail
// loudly the next time someone reaches for a caret.

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BROWSING_GUIDANCE,
  BROWSING_GUIDANCE_HEADING,
  OPENCLAW_INSTALL_COMMAND_SUDO,
  OPENCLAW_INSTALL_SPEC,
  withBrowsingGuidance,
} from '../index'

describe('OPENCLAW_INSTALL_SPEC', () => {
  it('is NEVER a caret range', () => {
    // The whole bug in one assertion. `^2026.5` reads as a pin and behaves as
    // "anything this year".
    expect(OPENCLAW_INSTALL_SPEC).not.toContain('^')
  })

  it('is never @latest either', () => {
    // The manual-fallback copies had drifted to this, which is the same failure
    // with none of the disguise.
    expect(OPENCLAW_INSTALL_SPEC).not.toContain('latest')
  })

  it('pins a minor line with a tilde', () => {
    // `~2026.5` is `>=2026.5.0 <2026.6.0`: patches inside a tested line, and
    // nothing beyond it.
    expect(OPENCLAW_INSTALL_SPEC).toMatch(/^openclaw@~\d{4}\.\d+$/)
  })

  it('names the package it installs', () => {
    expect(OPENCLAW_INSTALL_SPEC.startsWith('openclaw@')).toBe(true)
  })
})

describe('OPENCLAW_INSTALL_COMMAND_SUDO', () => {
  it('carries the SAME spec as the automatic install', () => {
    // The three copies drifting apart is how the manual instructions ended up
    // telling people to install a version the automatic path refused to.
    expect(OPENCLAW_INSTALL_COMMAND_SUDO).toContain(OPENCLAW_INSTALL_SPEC)
  })

  it('is a runnable global install command', () => {
    expect(OPENCLAW_INSTALL_COMMAND_SUDO).toBe(`sudo npm install -g ${OPENCLAW_INSTALL_SPEC}`)
  })
})

// ─── Browsing guidance ───────────────────────────────────────────────────────
//
// An externally-run agent carries its own shell, and shelling out to open a page
// uses the operator's REAL browser and their signed-in profile. The guidance
// points agents at their own browser tool instead. It is advisory, so what these
// tests protect is not that it works, but that it is DELIVERED and delivered
// once, without eating the operator's own instructions on the way in.

describe('withBrowsingGuidance', () => {
  it('adds the guidance to a file that has none', () => {
    const out = withBrowsingGuidance('# My agent\n\nDo the thing.')
    expect(out).toContain(BROWSING_GUIDANCE_HEADING)
    // The operator's words survive. This file is theirs; the guidance is a guest.
    expect(out).toContain('Do the thing.')
  })

  it('writes the guidance even when the file is empty or missing', () => {
    // The creation path skips a file with no content, so an agent created with no
    // AGENTS.md would silently never receive this.
    for (const empty of [undefined, null, '', '   \n']) {
      expect(withBrowsingGuidance(empty)).toContain(BROWSING_GUIDANCE_HEADING)
    }
  })

  it('does NOT stack copies when applied twice', () => {
    // A resync or a repeated create must not append it again.
    const once = withBrowsingGuidance('# Mine')
    const twice = withBrowsingGuidance(once)
    expect(twice).toBe(once)
    expect(twice.split(BROWSING_GUIDANCE_HEADING)).toHaveLength(2)
  })

  it("names the profile that reaches the operator's real browser", () => {
    // The load-bearing line. The other two are hygiene; this one is the reason
    // the guidance exists, and a reworded version that drops it has lost the point.
    expect(BROWSING_GUIDANCE).toContain('profile: "user"')
  })

  it('tells the agent what to use, not only what to avoid', () => {
    // An instruction that only forbids leaves the agent with no route, and it
    // will find its own. That route is the shell.
    expect(BROWSING_GUIDANCE).toContain('exec')
  })

  it('names a tool the agent ACTUALLY HAS', () => {
    // The correction this assertion exists for. An earlier draft said "use your
    // browser tool", and a live test found OpenClaw agents have no browser tool:
    // the Gateway registers it only when a dedicated browser profile and its
    // control service are configured. Naming a missing tool fails exactly like
    // naming none, because the agent falls back to the shell.
    //
    // `web_fetch` is in every OpenClaw agent's toolset and is what they already
    // reach for when asked to read a page.
    expect(BROWSING_GUIDANCE).toContain('web_fetch')
  })
})

// ─── Docs must not contradict the constant ───────────────────────────────────
//
// Fixing the spec in code fixed nothing for anyone READING the docs: eight lines
// across four user-facing pages still said `npm install -g openclaw@^2026.5`,
// which resolves to the newest 2026.x — the exact version the code was changed to
// avoid, and the one that breaks agent creation, the capability toggles, chat
// sends and approvals. Someone following the written instructions got the broken
// install while the product installed the right one.
//
// This is the gate that keeps the two in step. It fails when a doc names an
// OpenClaw install spec that is not the shipped constant, so the next person to
// change the pin cannot leave the docs behind.

const REPO_DOCS = path.resolve(__dirname, '../../../../docs')
/** `npm install -g openclaw@<spec>` in prose, however the line is worded. */
const INSTALL_IN_PROSE = /openclaw@[^\s`'")\]]+/g

function docFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return docFiles(full)
    return /\.mdx?$/.test(e.name) ? [full] : []
  })
}

describe('docs agree with OPENCLAW_INSTALL_SPEC', () => {
  it('no user-facing page names a different OpenClaw install spec', () => {
    const files = docFiles(REPO_DOCS)
    // Guard the guard: a zero-file sweep would pass silently if docs/ ever moves.
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      // The changelog RECORDS what past versions did, including the caret bug
      // itself. Rewriting history to match today's pin would make it a lie.
      if (path.basename(file).startsWith('changelog')) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const [spec] of text.matchAll(INSTALL_IN_PROSE)) {
        if (spec !== OPENCLAW_INSTALL_SPEC) {
          offenders.push(`${path.relative(REPO_DOCS, file)}: ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
