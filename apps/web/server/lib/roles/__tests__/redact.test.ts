// What a guest reads of text the board stored: each note that may name a task is read
// strictly against the shapes the board writes, a title is shown only when it is the
// title of a task on one of their teams, and a note that cannot be read is hidden.

import { describe, expect, it } from 'vitest'

import {
  HIDDEN_NOTE,
  OTHER_TEAM_TASK,
  redactForGuest,
  redactNote,
  type TitleCheck,
} from '../redact'

const theirs: TitleCheck = (quoted) =>
  [
    'Write the brief',
    'Photos',
    'x'.repeat(60) /* a long title, cut at 60 */,
    'Menu ”draft” v2' /* their own, with curly quotes of its own */,
    'Launch "Q4" menu' /* their own, with straight quotes of its own */,
  ].includes(quoted)

/** No part of `secret` longer than two characters is left in `out`. */
function leaksNothingOf(out: string, secret: string): void {
  for (const part of secret.split(/[“”"]/).filter((p) => p.trim().length > 2)) {
    expect(out).not.toContain(part)
  }
}

const UNFINISHED = ' did not finish. Retry them, or mark this task done.'
const ENDS = [
  'is done.',
  'is done, and nothing started this one again. Retry it or decide what happens next.',
  'was cancelled. Decide what happens next.',
]

describe('redactNote: a note that reads one way', () => {
  it('reads a release note as the one written now, unless the title is theirs', () => {
    for (const end of ENDS) {
      expect(
        redactNote(`“Unannounced launch”, the task this waited on, ${end}`, 'comment', theirs),
      ).toBe(`The task this waited on, on another team, ${end}`)
      for (const own of ['Write the brief', 'Menu ”draft” v2']) {
        const note = `“${own}”, the task this waited on, ${end}`
        expect(redactNote(note, 'need', theirs)).toBe(note)
      }
    }
  })

  it('hides all of a title holding both kinds of quote in a release note', () => {
    for (const end of ENDS) {
      const out = redactNote(
        `“Plan ”Secret “notes” "x"”, the task this waited on, ${end}`,
        'comment',
        theirs,
      )
      expect(out).toBe(`The task this waited on, on another team, ${end}`)
    }
  })

  it('replaces each title of a list that is not theirs, and keeps theirs, cut or whole', () => {
    expect(
      redactNote(`“Ads copy”, “Write the brief”, “${'x'.repeat(60)}”${UNFINISHED}`, 'need', theirs),
    ).toBe(`${OTHER_TEAM_TASK}, “Write the brief”, “${'x'.repeat(60)}”${UNFINISHED}`)
    // A list cut between names, as the board writes one now.
    expect(
      redactNote(`“Write the brief”, “Ads copy”, and 3 more${UNFINISHED}`, 'need', theirs),
    ).toBe(`“Write the brief”, ${OTHER_TEAM_TASK}, and 3 more${UNFINISHED}`)
    // Their own title with curly quotes of its own, in an old list.
    const own = `“Menu ”draft” v2”, “Write the brief”${UNFINISHED}`
    expect(redactNote(own, 'need', theirs)).toBe(own)
  })

  it('reads a closed-over note with both its lists', () => {
    expect(
      redactNote(
        'This closed over sub-tasks that did not get done. “Ads copy”, “Photos” did not finish. “Write the brief” cancelled.',
        'comment',
        theirs,
      ),
    ).toBe(
      `This closed over sub-tasks that did not get done. ${OTHER_TEAM_TASK}, “Photos” did not finish. “Write the brief” cancelled.`,
    )
  })

  it('shows a routine’s name, which is not a task’s title', () => {
    const note = 'From the routine “Weekly menu check”.'
    expect(redactNote(note, 'comment', theirs)).toBe(note)
  })

  it('reads a replaced plan, a refused hand-off and the room’s lines about tasks', () => {
    expect(
      redactNote(
        'A newer plan took the place of "Old plan". Nothing from that one started, and it stays readable as revision 2.',
        'comment',
        theirs,
      ),
    ).toBe(
      `A newer plan took the place of ${OTHER_TEAM_TASK}. Nothing from that one started, and it stays readable as revision 2.`,
    )
    expect(
      redactNote(
        'Not handed to Bo: they handed out "Launch "Acquisition" plan", which is still open.',
        'comment',
        theirs,
      ),
    ).toBe(`Not handed to Bo: they handed out ${OTHER_TEAM_TASK}, which is still open.`)
    // By its readable id, which is not a title.
    const byId = 'Not handed to Bo: they handed out ADS-12, which is still open.'
    expect(redactNote(byId, 'comment', theirs)).toBe(byId)

    for (const own of [
      'Task "Photos" claimed by agent-7.',
      'A person moved "Photos" to In progress.',
      'Ada on "Photos": looks "great" so far',
      'Task "Photos" now depends on "Launch "Q4" menu".',
      'Task "Photos" now depends on a task on another team.',
    ]) {
      expect(redactNote(own, 'post', theirs)).toBe(own)
    }
    expect(
      redactNote('Task "Photos" now depends on "Launch "Acquisition" plan".', 'post', theirs),
    ).toBe(`Task "Photos" now depends on ${OTHER_TEAM_TASK}.`)
    expect(redactNote('A person moved "Ads ”copy“ "v2"" to Done.', 'post', theirs)).toBe(
      `A person moved ${OTHER_TEAM_TASK} to Done.`,
    )
  })
})

describe('redactNote: a title holding both kinds of quote, in every shape', () => {
  // Words no shape's own text holds, so any of them in the output is a leak.
  const secret = 'Ads ”Secret“ "budget" figures'
  const notes: Array<[string, 'comment' | 'need' | 'post']> = [
    ...ENDS.map((end): [string, 'need'] => [
      `“${secret}”, the task this waited on, ${end}`,
      'need',
    ]),
    [`“${secret}”${UNFINISHED}`, 'need'],
    [`“Write the brief”, “${secret}”, and 2 more${UNFINISHED}`, 'need'],
    [`This closed over sub-tasks that did not get done. “${secret}” did not finish.`, 'comment'],
    [
      `A newer plan took the place of "${secret}". Nothing from that one started, and it stays readable as revision 3.`,
      'comment',
    ],
    [`Not handed to Bo: they handed out "${secret}", which is still open.`, 'comment'],
    [`Task "${secret}" claimed by agent-7.`, 'post'],
    [`A person moved "${secret}" to Done.`, 'post'],
    [`Ada on "${secret}": on it`, 'post'],
    [`Task "Photos" now depends on "${secret}".`, 'post'],
    [`Task "${secret}" now depends on a task on another team.`, 'post'],
  ]

  it('shows none of it, in a note it reads or one it hides', () => {
    for (const [note, field] of notes) {
      const out = redactNote(note, field, theirs)
      leaksNothingOf(out, secret)
      expect(
        [
          HIDDEN_NOTE,
          ...ENDS.map((e) => `The task this waited on, on another team, ${e}`),
        ].includes(out) || out.includes(OTHER_TEAM_TASK),
        note,
      ).toBe(true)
    }
  })
})

describe('redactNote: a note that cannot be read strictly is hidden whole', () => {
  it('hides the note from the review: a title holding a closing and an opening quote', () => {
    expect(redactNote(`“Plan ”Secret “notes”${UNFINISHED}`, 'need', theirs)).toBe(HIDDEN_NOTE)
  })

  it('hides a list or a closed-over note holding a title with both kinds of quote', () => {
    for (const note of [
      `“Write the brief”, “Plan ”Se"cret“ x”${UNFINISHED}`,
      `“Plan ”Secret” notes”, “Write the brief”${UNFINISHED}`,
      'This closed over sub-tasks that did not get done. “Plan ”Secret “notes” cancelled.',
    ]) {
      const out = redactNote(note, 'need', theirs)
      expect(out).toBe(HIDDEN_NOTE)
      leaksNothingOf(out, 'Plan Secret notes')
    }
  })

  it('hides a list joined other than the board joins one', () => {
    for (const note of [
      `“Ads copy”; “Write the brief”${UNFINISHED}`,
      `“Ads copy”, and “Write the brief”${UNFINISHED}`,
      `“Ads copy”, and more${UNFINISHED}`,
      `“Ads copy” “Write the brief”${UNFINISHED}`,
    ]) {
      expect(redactNote(note, 'need', theirs)).toBe(HIDDEN_NOTE)
    }
  })

  it('hides a note cut short, inside a title or after one', () => {
    expect(redactNote('“Write the brief”, “Unannounced lau', 'need', theirs)).toBe(HIDDEN_NOTE)
    const head = Array.from({ length: 50 }, () => '“Write the brief”').join(', ') + ', '
    const long = `${head}“Plan ”Secr`.padStart(1000, ' ')
    expect(long).toHaveLength(1000)
    expect(redactNote(long, 'need', theirs)).toBe(HIDDEN_NOTE)
    expect(
      redactNote('A hand-off did not start: Bo handed out "Launch "Acquisi', 'comment', theirs),
    ).toBe(HIDDEN_NOTE)
  })

  it('hides a note that reads more than one way', () => {
    // The title could end at either `": `.
    expect(redactNote('Ada on "Fix": now": done', 'post', theirs)).toBe(HIDDEN_NOTE)
  })
})

describe('redactNote: a note full of quotes reads in bounded time', () => {
  /** Runs `read` and says how long it took, in milliseconds. */
  const timed = (read: () => string): [string, number] => {
    const start = performance.now()
    const out = read()
    return [out, performance.now() - start]
  }

  // As titlesOnTeams checks: a set, so each candidate title is hashed in full.
  const known = new Set(['Write the brief', 'Photos'])
  const bySet: TitleCheck = (quoted) => known.has(quoted)

  it('reads a title of tens of thousands of straight quotes quickly, hiding it', () => {
    for (const quotes of [9_000, 30_000]) {
      const title = 'x"'.repeat(quotes)
      // The ’ makes the note wide text, which a scan for curly quotes reads in full.
      const note = `Task "${title}" claimed by agent’s-7.`
      const [out, ms] = timed(() => redactNote(note, 'post', bySet))
      expect(ms).toBeLessThan(200)
      expect(out).not.toContain('x"x"x')
      expect([HIDDEN_NOTE, `Task ${OTHER_TEAM_TASK} claimed by agent’s-7.`]).toContain(out)
    }
  })

  it('reads a title of tens of thousands of curly quotes quickly, hiding it', () => {
    for (const pairs of [6_000, 20_000]) {
      const title = 'y”“'.repeat(pairs)
      for (const note of [
        `“${title}”, “Write the brief”${UNFINISHED}`,
        `“${title}”, the task this waited on, is done.`,
      ]) {
        const [out, ms] = timed(() => redactNote(note, 'need', bySet))
        expect(ms).toBeLessThan(200)
        expect(out).not.toContain('y”“y')
        expect([HIDDEN_NOTE, 'The task this waited on, on another team, is done.']).toContain(out)
      }
    }
  })

  it('reads a list of thousands of quoted titles quickly, hiding them', () => {
    for (const items of [3_500, 8_000]) {
      const note = `${Array.from({ length: items }, () => '“a”').join(', ')}${UNFINISHED}`
      const [out, ms] = timed(() => redactNote(note, 'need', bySet))
      expect(ms).toBeLessThan(200)
      expect(out).not.toContain('“a”')
      // Read whole, every title replaced, or hidden as a note too long to read.
      const read = `${Array.from({ length: items }, () => OTHER_TEAM_TASK).join(', ')}${UNFINISHED}`
      expect([HIDDEN_NOTE, read]).toContain(out)
    }
  })
})

describe('redactNote: a note that cannot name a task is left alone', () => {
  it('leaves a note with no quotes, and straight quotes the board does not put a title in', () => {
    for (const note of [
      'Ran out of room before finishing, so it gets one more run to continue.',
      'Spawn depth limit (3) reached, not delegating "Draft the menu".',
      'Run failed: Cannot find module "left-pad"',
    ]) {
      expect(redactNote(note, 'comment', theirs)).toBe(note)
    }
  })
})

describe('redactForGuest', () => {
  const old = '“Unannounced launch”, the task this waited on, is done.'
  const now = 'The task this waited on, on another team, is done.'

  it('redacts what the board wrote: system comments, wait reasons, attention, room posts', () => {
    const body = {
      task: {
        id: 't1',
        waitingOn: JSON.stringify({ kind: 'person', need: old }),
        attention: { reason: 'blocked', failedRuns: 0, detail: old },
      },
      comments: [
        { authorType: 'system', body: old },
        { authorType: 'user', body: old },
      ],
      posts: [{ kind: 'system', body: 'Task "Photos" now depends on "Unannounced launch".' }],
    }
    const out = redactForGuest(body, () => theirs) as typeof body
    expect(JSON.parse(out.task.waitingOn)).toEqual({ kind: 'person', need: now })
    expect(out.task.attention.detail).toBe(now)
    expect(out.comments[0]!.body).toBe(now)
    // What a person wrote is theirs to have written.
    expect(out.comments[1]!.body).toBe(old)
    expect(out.posts[0]!.body).toBe(`Task "Photos" now depends on ${OTHER_TEAM_TASK}.`)
    // The stored rows are not touched.
    expect(body.comments[0]!.body).toBe(old)
  })

  it('leaves a wait reason a person or an agent wrote, and its attention detail', () => {
    const said = 'Waiting on “Unannounced launch” from the ads team'
    for (const by of ['agent', 'person']) {
      const body = {
        task: {
          waitingOn: { kind: 'person', need: said, by },
          attention: { reason: 'blocked', failedRuns: 0, detail: said },
        },
      }
      expect(redactForGuest(body, () => theirs)).toBe(body)
    }
    // A wait on unfinished sub-tasks is the board's, whoever set it.
    const list = {
      waitingOn: {
        kind: 'person',
        need: `“Ads copy”${UNFINISHED}`,
        by: 'agent',
        untilSubtasks: true,
      },
    }
    expect(redactForGuest(list, () => theirs)).toEqual({
      waitingOn: { ...list.waitingOn, need: `${OTHER_TEAM_TASK}${UNFINISHED}` },
    })
  })

  it('returns the same object, and reads no titles, when no note may name a task', () => {
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
