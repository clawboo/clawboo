// What a guest reads of text the board stored: a title is shown only when it is the
// title of a task on one of their teams.

import { describe, expect, it } from 'vitest'

import { OTHER_TEAM_TASK, redactForGuest, redactTitles, type TitleCheck } from '../redact'

const theirs: TitleCheck = (quoted) =>
  quoted === 'Write the brief' || quoted === 'x'.repeat(60) /* a long title, cut at 60 */

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
