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

import { describe, expect, it } from 'vitest'

import { OPENCLAW_INSTALL_COMMAND_SUDO, OPENCLAW_INSTALL_SPEC } from '../index'

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
