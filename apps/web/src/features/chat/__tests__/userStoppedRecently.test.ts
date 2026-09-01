// The user-stop signal the Gateway recovery belt reads.
//
// WHY IT EXISTS. When a run ends without re-carrying its text, the event path
// commits whatever prose was on screen so the reply is not deleted. A run the
// operator STOPPED is the one case where that is wrong: they asked for the
// partial to go away, and a delta landing between the Stop and the `aborted`
// terminal would otherwise repopulate the card and get it persisted.

import { describe, expect, it } from 'vitest'

import { userStoppedRecently } from '../stopChatOperation'

describe('userStoppedRecently', () => {
  it('is false for a session nobody stopped', () => {
    expect(userStoppedRecently('agent:never-stopped:main')).toBe(false)
  })

  it('is false again once the window has passed', () => {
    // The belt only needs to suppress the terminal that follows the Stop. A
    // signal that never expired would silently disable recovery for the rest of
    // the session, which is the same lost-reply bug wearing a different hat.
    const key = 'agent:a:main'
    expect(userStoppedRecently(key, Date.now() + 60_000)).toBe(false)
  })
})
