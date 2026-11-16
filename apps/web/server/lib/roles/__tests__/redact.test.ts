// What a guest reads of text the board stored: a title is shown only when it is the
// title of a task on one of their teams.

import { describe, expect, it } from 'vitest'

import { OTHER_TEAM_TASK, redactForGuest, redactTitles, type TitleCheck } from '../redact'

const theirs: TitleCheck = (quoted) =>
  quoted === 'Write the brief' ||
  quoted === 'x'.repeat(60) /* a long title, cut at 60 */ ||
  quoted === 'Menu ”draft” v2' /* their own title, with quotes of its own */ ||
  quoted === 'Launch "Q4" menu'

/** No character of `secret` that the guest may not read is left in `out`. */
function leaksNothingOf(out: string, secret: string): void {
  for (const part of secret.split(/[“”"]/).filter((p) => p.trim().length > 2)) {
    expect(out).not.toContain(part)
  }
}

describe('redactTitles', () => {
  it('reads an old release note as the one written now, unless the title is theirs', () => {
    for (const end of [
      'is done.',
      'is done, and nothing started this one again. Retry it or decide what happens next.',
      'was cancelled. Decide what happens next.',
    ]) {
      expect(redactTitles(`“Unannounced launch”, the task this waited on, ${end}`, theirs)).toBe(
        `The task this waited on, on another team, ${end}`,
      )
      const own = `“Write the brief”, the task this waited on, ${end}`
      expect(redactTitles(own, theirs)).toBe(own)
    }
  })

  it('replaces each quoted title that is not theirs, and keeps theirs, cut or whole', () => {
    expect(
      redactTitles(
        `“Ads copy”, “Write the brief”, “${'x'.repeat(60)}” did not finish. Retry them, or mark this task done.`,
        theirs,
      ),
    ).toBe(
      `${OTHER_TEAM_TASK}, “Write the brief”, “${'x'.repeat(60)}” did not finish. Retry them, or mark this task done.`,
    )
  })

  it('replaces the straight-quoted title in a refused hand-off and in a dependency line', () => {
    expect(
      redactTitles(
        'Not handed to Bo: they handed out "Unannounced launch", which is still open.',
        theirs,
      ),
    ).toBe(`Not handed to Bo: they handed out ${OTHER_TEAM_TASK}, which is still open.`)
    expect(
      redactTitles('Task "Write the brief" now depends on "Unannounced launch".', theirs),
    ).toBe(`Task "Write the brief" now depends on ${OTHER_TEAM_TASK}.`)
  })

  it('leaves other straight quotes alone: a hand-off’s own words are not another task', () => {
    const words = 'Spawn depth limit (3) reached, not delegating "Draft the menu".'
    expect(redactTitles(words, theirs)).toBe(words)
  })
})

describe('redactTitles, failing closed', () => {
  const secret = 'Plan ”Secret” notes'

  it('hides all of a title of another team that holds quotes of its own', () => {
    for (const note of [
      `“${secret}”, the task this waited on, is done.`,
      `“${secret}” did not finish. Retry them, or mark this task done.`,
      `This closed over sub-tasks that did not get done. “${secret}” cancelled.`,
    ]) {
      const out = redactTitles(note, theirs)
      leaksNothingOf(out, secret)
      expect(out).toContain('another team')
    }
  })

  it('hides it inside a list of sub-tasks, whatever comes after it', () => {
    const out = redactTitles(
      `“Write the brief”, “${secret}”, “Ads copy” did not finish. Retry them, or mark this task done.`,
      theirs,
    )
    leaksNothingOf(out, secret)
    expect(out).not.toContain('Ads copy')
    // What comes before it reads as it did.
    expect(out.startsWith('“Write the brief”, ')).toBe(true)
  })

  it('hides a title a long note was cut inside, to the end of the note', () => {
    expect(redactTitles('“Write the brief”, “Unannounced lau', theirs)).toBe(
      `“Write the brief”, ${OTHER_TEAM_TASK}`,
    )
    const cut = redactTitles(`“Write the brief”, “Plan ”Secret” no`, theirs)
    expect(cut).toBe(`“Write the brief”, ${OTHER_TEAM_TASK}`)
    // A list once cut at 1000 characters can end just after a quote inside a title.
    const head = Array.from({ length: 50 }, () => '“Write the brief”').join(', ') + ', '
    const long = `${head}“Plan ”Secr`.padStart(1000, ' ')
    expect(long).toHaveLength(1000)
    const shown = redactTitles(long, theirs)
    expect(shown).not.toContain('Secr')
    expect(shown.endsWith(OTHER_TEAM_TASK)).toBe(true)
  })

  it('still shows their own title that holds quotes, whole', () => {
    const note =
      '“Menu ”draft” v2”, “Write the brief” did not finish. Retry them, or mark this task done.'
    expect(redactTitles(note, theirs)).toBe(note)
    const old = '“Menu ”draft” v2”, the task this waited on, is done.'
    expect(redactTitles(old, theirs)).toBe(old)
  })

  it('reads a straight-quoted title to the note’s own end, and hides all of it', () => {
    const room = 'Task "Photos" now depends on "Launch "Acquisition" plan".'
    expect(redactTitles(room, theirs)).toBe(`Task "Photos" now depends on ${OTHER_TEAM_TASK}.`)
    const refused =
      'Not handed to Bo: they handed out "Launch "Acquisition" plan", which is still open.'
    expect(redactTitles(refused, theirs)).toBe(
      `Not handed to Bo: they handed out ${OTHER_TEAM_TASK}, which is still open.`,
    )
    // Cut short before its end: everything from the opening quote goes.
    expect(redactTitles('A hand-off did not start: Bo handed out "Launch "Acquisi', theirs)).toBe(
      `A hand-off did not start: Bo handed out ${OTHER_TEAM_TASK}`,
    )
    // Their own, quotes and all, stays.
    const own = 'Task "Photos" now depends on "Launch "Q4" menu".'
    expect(redactTitles(own, theirs)).toBe(own)
  })
})

describe('redactForGuest', () => {
  const old = '“Unannounced launch”, the task this waited on, is done.'
  const now = 'The task this waited on, on another team, is done.'

  it('redacts what the board wrote: system comments, wait reasons, attention, room posts', () => {
    const body = {
      task: {
        id: 't1',
        waitingOn: JSON.stringify({ kind: 'person', need: old, by: 'agent' }),
        attention: { reason: 'blocked', failedRuns: 0, detail: old },
      },
      comments: [
        { authorType: 'system', body: old },
        { authorType: 'user', body: old },
      ],
      posts: [{ kind: 'system', body: old }],
    }
    const out = redactForGuest(body, () => theirs) as typeof body
    expect(JSON.parse(out.task.waitingOn)).toEqual({ kind: 'person', need: now, by: 'agent' })
    expect(out.task.attention.detail).toBe(now)
    expect(out.comments[0]!.body).toBe(now)
    // What a person wrote is theirs to have written.
    expect(out.comments[1]!.body).toBe(old)
    expect(out.posts[0]!.body).toBe(now)
    // The stored rows are not touched.
    expect(body.comments[0]!.body).toBe(old)
  })

  it('reads a wait reason given as an object too', () => {
    const out = redactForGuest({ waitingOn: { kind: 'person', need: old } }, () => theirs)
    expect(out).toEqual({ waitingOn: { kind: 'person', need: now } })
  })

  it('returns the same object, and reads no titles, when nothing quotes one', () => {
    let reads = 0
    const body = {
      tasks: [{ id: 't1', waitingOn: null }],
      comments: [{ authorType: 'system', body: 'Done.' }],
    }
    expect(
      redactForGuest(body, () => {
        reads += 1
        return theirs
      }),
    ).toBe(body)
    expect(reads).toBe(0)
  })
})
