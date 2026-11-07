// Who "you" is on the board: the person a sign-in proxy vouched for, else the
// install's built-in person. Read once per page load and kept: it cannot change
// without a reload, and every card that says "you" reads it.

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

/** `needed` false skips the read: most cards never ask who you are. */
export function useBoardPerson(needed = true): BoardPerson {
  const [person, setPerson] = useState<BoardPerson>(known ?? { ...LOCAL_PERSON })
  useEffect(() => {
    if (!needed) return
    if (known) {
      setPerson(known)
      return
    }
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const readPerson = (): void => {
      reading ??= fetchBoardPerson()
      void reading.then((read) => {
        if (!read) reading = null
        else known = read
        if (!live) return
        if (read) setPerson(read)
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
  return person
}
