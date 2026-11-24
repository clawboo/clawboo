// Who "you" is on the board, and in the account bar at the bottom of the
// sidebar: the person a sign-in proxy vouched for, else the install's built-in
// person. Read once per page load and kept: it cannot change without a reload,
// and every card that says "you" reads it.

import { useEffect, useState } from 'react'

import { LOCAL_PERSON } from '@clawboo/board-core'

import { fetchBoardPerson } from '@/lib/boardClient'

export interface BoardPerson {
  id: string
  name: string | null
  role: string | null
}

/** How long before a read that failed is tried again, while something still asks. */
export const BOARD_PERSON_RETRY_MS = 10_000

let known: BoardPerson | null = null
let reading: Promise<BoardPerson | null> | null = null

/** Test helper: forget who was read. */
export function resetBoardPerson(): void {
  known = null
  reading = null
}

interface PersonRead {
  person: BoardPerson
  /** True once the server has said who you are; until then `person` is the
   *  built-in one as a stand-in. */
  settled: boolean
}

function usePersonRead(needed: boolean): PersonRead {
  const [read, setRead] = useState<PersonRead>(() =>
    known ? { person: known, settled: true } : { person: { ...LOCAL_PERSON }, settled: false },
  )
  useEffect(() => {
    if (!needed) return
    if (known) {
      const person = known
      // The same state again bails out, so a card that mounts after the read
      // does not render twice.
      setRead((r) => (r.settled && r.person === person ? r : { person, settled: true }))
      return
    }
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const readPerson = (): void => {
      reading ??= fetchBoardPerson()
      void reading.then((person) => {
        if (!person) reading = null
        else known = person
        if (!live) return
        if (person) setRead({ person, settled: true })
        // A list that says "nothing assigned to you" would otherwise stay wrong until
        // the page reloads.
        else retry = setTimeout(readPerson, BOARD_PERSON_RETRY_MS)
      })
    }
    readPerson()
    return () => {
      live = false
      clearTimeout(retry)
    }
  }, [needed])
  return read
}

/** `needed` false skips the read: most cards never ask who you are. */
export function useBoardPerson(needed = true): BoardPerson {
  return usePersonRead(needed).person
}

/** Who "you" are once the server has said, or null until then and for as long
 *  as the read keeps failing. For words that must never name the wrong person,
 *  such as the account bar's. */
export function useBoardPersonIfKnown(): BoardPerson | null {
  const read = usePersonRead(true)
  return read.settled ? read.person : null
}
